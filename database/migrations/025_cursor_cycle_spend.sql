-- ============================================================================
-- Migration 025: Cursor billing-cycle on-demand spend snapshots (issue #76)
-- ----------------------------------------------------------------------------
-- Cursor's Admin API POST /teams/spend reports the CURRENT billing cycle only:
-- per member spendCents (on-demand: usage beyond the plan's included pool),
-- overallSpendCents (included + on-demand, never billed as such), the
-- member's monthlyLimitDollars / hardLimitOverrideDollars /
-- effectivePerUserLimitDollars, and the team's subscriptionCycleStart. When
-- the cycle resets the previous cycle's figures disappear from the API, so the
-- app snapshots the response (hourly cron, and after each Cursor collection)
-- and this migration keeps one row per cycle and one per (cycle, member).
--
-- Billing-cycle totals live here only. Nothing is written to cost_records,
-- cost_records_daily or cost_records_daily_attributed: usage events stay the
-- source for daily history, calendar-month totals and the by-product split.
--
-- This migration adds:
--
--   1. cursor_spend_cycles: one row per billing cycle (cycle_start =
--      subscriptionCycleStart). team_spend_cents is the sum of the cycle's
--      member spend_cents (the team's on-demand total);
--      team_overall_spend_cents is the sum of overall_spend_cents and is
--      informational only.
--
--   2. cursor_member_cycle_spend: one row per (cycle, member email) with the
--      /teams/spend fields above. A member who drops out of the API mid-cycle
--      keeps their last snapshot.
--
--   3. cursor_cycle_spend_guard trigger on both tables: once a later cycle
--      exists, rows of earlier cycles can be neither updated nor deleted, and
--      no row may be inserted into an earlier cycle. Prior-cycle snapshots are
--      immutable.
--
--   4. record_cursor_spend_snapshot(...): the one write path. Atomically
--      upserts the current cycle's member rows and recomputes the cycle's
--      team totals. A snapshot older than the latest stored cycle is refused
--      (returns 'stale') and writes nothing. SECURITY INVOKER, pinned
--      search_path, EXECUTE for service_role only.
--
-- Access: RLS on; authenticated may SELECT (the dashboard reads it like the
-- other spend data); writes are service_role only.
--
-- The app degrades safely while this migration is not applied: the snapshot
-- step reports "migration 025 not applied" and writes nothing, and the
-- dashboard shows a notice in place of the cycle card. Every existing total
-- is unchanged either way.
--
-- Idempotent: safe to re-run.
--
-- Rollback (removes every stored cycle snapshot; cost_records is unaffected):
--   DROP FUNCTION IF EXISTS public.record_cursor_spend_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB);
--   DROP TABLE IF EXISTS public.cursor_member_cycle_spend;
--   DROP TABLE IF EXISTS public.cursor_spend_cycles;
--   DROP FUNCTION IF EXISTS public.cursor_cycle_spend_guard();
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cursor_spend_cycles (
    cycle_start TIMESTAMPTZ PRIMARY KEY,
    team_id TEXT,
    team_spend_cents NUMERIC(16, 4) NOT NULL DEFAULT 0,
    team_overall_spend_cents NUMERIC(16, 4),
    member_count INTEGER NOT NULL DEFAULT 0,
    first_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cursor_spend_cycles_spend_nonnegative CHECK (team_spend_cents >= 0),
    CONSTRAINT cursor_spend_cycles_members_nonnegative CHECK (member_count >= 0)
);

COMMENT ON TABLE public.cursor_spend_cycles IS
    'Cursor billing cycles from /teams/spend snapshots (issue #76); rows of a cycle are frozen once a later cycle exists';
COMMENT ON COLUMN public.cursor_spend_cycles.cycle_start IS
    'Cursor subscriptionCycleStart for the cycle';
COMMENT ON COLUMN public.cursor_spend_cycles.team_spend_cents IS
    'Sum of the cycle''s member spend_cents (Cursor spendCents): the team''s billed on-demand total for the cycle';
COMMENT ON COLUMN public.cursor_spend_cycles.team_overall_spend_cents IS
    'Sum of member overall_spend_cents (included + on-demand); informational, never billed on-demand';
COMMENT ON COLUMN public.cursor_spend_cycles.captured_at IS
    'When the latest snapshot of the cycle was taken';

CREATE TABLE IF NOT EXISTS public.cursor_member_cycle_spend (
    cycle_start TIMESTAMPTZ NOT NULL REFERENCES public.cursor_spend_cycles(cycle_start) ON DELETE RESTRICT,
    member_email TEXT NOT NULL,
    member_name TEXT,
    cursor_user_id TEXT,
    role TEXT,
    spend_cents NUMERIC(16, 4),
    overall_spend_cents NUMERIC(16, 4),
    monthly_limit_dollars NUMERIC(12, 2),
    hard_limit_override_dollars NUMERIC(12, 2),
    effective_per_user_limit_dollars NUMERIC(12, 2),
    first_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (cycle_start, member_email),
    CONSTRAINT cursor_member_cycle_spend_email_lower CHECK (member_email = lower(member_email) AND member_email <> '')
);

COMMENT ON TABLE public.cursor_member_cycle_spend IS
    'Per-member Cursor /teams/spend snapshot for a billing cycle (issue #76); frozen once a later cycle exists';
COMMENT ON COLUMN public.cursor_member_cycle_spend.spend_cents IS
    'Cursor spendCents: the member''s on-demand spend this cycle (excludes included usage)';
COMMENT ON COLUMN public.cursor_member_cycle_spend.overall_spend_cents IS
    'Cursor overallSpendCents: included + on-demand; never a substitute for spend_cents';

-- ----------------------------------------------------------------------------
-- 2. Prior cycles are immutable
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cursor_cycle_spend_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cycle TIMESTAMPTZ;
BEGIN
    v_cycle := CASE WHEN TG_OP = 'INSERT' THEN NEW.cycle_start ELSE OLD.cycle_start END;
    IF EXISTS (SELECT 1 FROM cursor_spend_cycles c WHERE c.cycle_start > v_cycle) THEN
        RAISE EXCEPTION 'cursor cycle %: a later cycle exists, so this cycle''s snapshot is final (%)',
            v_cycle, TG_OP
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.cycle_start IS DISTINCT FROM OLD.cycle_start THEN
        RAISE EXCEPTION 'cursor cycle %: cycle_start cannot change', OLD.cycle_start
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.cursor_cycle_spend_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cursor_cycle_spend_guard ON public.cursor_spend_cycles;
CREATE TRIGGER cursor_cycle_spend_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.cursor_spend_cycles
    FOR EACH ROW EXECUTE FUNCTION public.cursor_cycle_spend_guard();

DROP TRIGGER IF EXISTS cursor_cycle_spend_guard ON public.cursor_member_cycle_spend;
CREATE TRIGGER cursor_cycle_spend_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.cursor_member_cycle_spend
    FOR EACH ROW EXECUTE FUNCTION public.cursor_cycle_spend_guard();

-- ----------------------------------------------------------------------------
-- 3. Access
-- ----------------------------------------------------------------------------
ALTER TABLE public.cursor_spend_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cursor_member_cycle_spend ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can view cursor spend cycles" ON public.cursor_spend_cycles;
CREATE POLICY "Authenticated can view cursor spend cycles"
    ON public.cursor_spend_cycles FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated can view cursor member cycle spend" ON public.cursor_member_cycle_spend;
CREATE POLICY "Authenticated can view cursor member cycle spend"
    ON public.cursor_member_cycle_spend FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.cursor_spend_cycles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cursor_member_cycle_spend FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cursor_spend_cycles TO authenticated;
GRANT SELECT ON public.cursor_member_cycle_spend TO authenticated;
GRANT ALL ON public.cursor_spend_cycles TO service_role;
GRANT ALL ON public.cursor_member_cycle_spend TO service_role;

-- ----------------------------------------------------------------------------
-- 4. The write path: record the current cycle's snapshot
-- ----------------------------------------------------------------------------
-- p_members: JSON array of objects with keys email, name, cursor_user_id,
-- role, spend_cents, overall_spend_cents, monthly_limit_dollars,
-- hard_limit_override_dollars, effective_per_user_limit_dollars.
-- Returns 'inserted' (first snapshot of a new cycle), 'updated' (another
-- snapshot of the latest cycle) or 'stale' (older than the latest stored
-- cycle; nothing written).
CREATE OR REPLACE FUNCTION public.record_cursor_spend_snapshot(
    p_cycle_start TIMESTAMPTZ,
    p_captured_at TIMESTAMPTZ,
    p_team_id TEXT,
    p_members JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_latest TIMESTAMPTZ;
    v_at TIMESTAMPTZ;
    v_status TEXT;
BEGIN
    IF p_cycle_start IS NULL THEN
        RAISE EXCEPTION 'record_cursor_spend_snapshot: cycle start is required';
    END IF;
    IF p_members IS NULL OR jsonb_typeof(p_members) <> 'array' THEN
        RAISE EXCEPTION 'record_cursor_spend_snapshot: members must be a JSON array';
    END IF;
    v_at := COALESCE(p_captured_at, NOW());

    -- Serialize snapshots so two runs can't interleave around a rollover.
    LOCK TABLE cursor_spend_cycles IN SHARE ROW EXCLUSIVE MODE;

    SELECT max(cycle_start) INTO v_latest FROM cursor_spend_cycles;
    IF v_latest IS NOT NULL AND p_cycle_start < v_latest THEN
        RETURN 'stale';
    END IF;
    v_status := CASE WHEN v_latest = p_cycle_start THEN 'updated' ELSE 'inserted' END;

    INSERT INTO cursor_spend_cycles (cycle_start, team_id, first_captured_at, captured_at)
    VALUES (p_cycle_start, NULLIF(p_team_id, ''), v_at, v_at)
    ON CONFLICT (cycle_start) DO UPDATE
        SET team_id = COALESCE(EXCLUDED.team_id, cursor_spend_cycles.team_id),
            captured_at = GREATEST(cursor_spend_cycles.captured_at, EXCLUDED.captured_at);

    INSERT INTO cursor_member_cycle_spend AS t (
        cycle_start, member_email, member_name, cursor_user_id, role,
        spend_cents, overall_spend_cents, monthly_limit_dollars,
        hard_limit_override_dollars, effective_per_user_limit_dollars,
        first_captured_at, captured_at)
    SELECT DISTINCT ON (lower(btrim(m.email)))
           p_cycle_start, lower(btrim(m.email)), NULLIF(m.name, ''), NULLIF(m.cursor_user_id, ''), NULLIF(m.role, ''),
           m.spend_cents, m.overall_spend_cents, m.monthly_limit_dollars,
           m.hard_limit_override_dollars, m.effective_per_user_limit_dollars,
           v_at, v_at
      FROM jsonb_to_recordset(p_members) AS m(
               email TEXT, name TEXT, cursor_user_id TEXT, role TEXT,
               spend_cents NUMERIC, overall_spend_cents NUMERIC,
               monthly_limit_dollars NUMERIC, hard_limit_override_dollars NUMERIC,
               effective_per_user_limit_dollars NUMERIC)
     WHERE m.email IS NOT NULL AND btrim(m.email) <> ''
     ORDER BY lower(btrim(m.email))
    ON CONFLICT (cycle_start, member_email) DO UPDATE
        SET member_name = EXCLUDED.member_name,
            cursor_user_id = EXCLUDED.cursor_user_id,
            role = EXCLUDED.role,
            spend_cents = EXCLUDED.spend_cents,
            overall_spend_cents = EXCLUDED.overall_spend_cents,
            monthly_limit_dollars = EXCLUDED.monthly_limit_dollars,
            hard_limit_override_dollars = EXCLUDED.hard_limit_override_dollars,
            effective_per_user_limit_dollars = EXCLUDED.effective_per_user_limit_dollars,
            captured_at = EXCLUDED.captured_at;

    -- Team totals from every member row of the cycle: on-demand is the sum of
    -- spend_cents only; overall is kept apart and never substituted for it.
    UPDATE cursor_spend_cycles c
       SET team_spend_cents = COALESCE(s.spend, 0),
           team_overall_spend_cents = s.overall,
           member_count = COALESCE(s.n, 0)
      FROM (SELECT sum(spend_cents) AS spend, sum(overall_spend_cents) AS overall, count(*) AS n
              FROM cursor_member_cycle_spend WHERE cycle_start = p_cycle_start) s
     WHERE c.cycle_start = p_cycle_start;

    RETURN v_status;
END $$;

COMMENT ON FUNCTION public.record_cursor_spend_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB) IS
    'Record a Cursor /teams/spend snapshot for the current billing cycle; earlier cycles are never changed (issue #76)';

REVOKE ALL ON FUNCTION public.record_cursor_spend_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cursor_spend_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB) TO service_role;
