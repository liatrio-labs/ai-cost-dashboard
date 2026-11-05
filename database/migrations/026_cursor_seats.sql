-- ============================================================================
-- Migration 026: Cursor seat types per person and monthly seat rates
-- ----------------------------------------------------------------------------
-- The Cursor Admin API does not expose a member's seat type (Standard /
-- Premium / Free) or the monthly seat subscription line, so the dashboard
-- only sees on-demand usage. This migration stores who holds which seat type
-- and what each type costs per month, so the app can attribute the monthly
-- seat fee to each person (and through them to their team and department)
-- and into Cursor totals.
--
-- Why dedicated tables instead of recurring_costs (022): a recurring_costs
-- segment is one amount per provider (optionally seats x one price), with any
-- per-person split inherited from a manual seat entry. Cursor seats are
-- per person with two paid prices, and the person, not the provider, is the
-- unit that changes. One row per (person, month the type takes effect) and
-- one row per (seat type, month the rate takes effect) model that directly
-- and keep both editable without touching cost_records.
--
-- Nothing is written to cost_records. The app expands assignments x rates at
-- read time into one synthetic row per billed person per month
-- (frontend/lib/cursor-seats.ts), dated the 1st with model_name
-- 'cursor seats'.
--
-- This migration adds:
--
--   1. cursor_seat_rates (seat_type, effective_month, monthly_rate_usd): a
--      type's rate for month M is the row with the latest effective_month
--      <= M. Seeded once: standard 40.00, premium 80.00, free 0.00, effective
--      2000-01 (ON CONFLICT DO NOTHING, so an admin's edits survive a re-run).
--
--   2. cursor_seat_assignments (person_id, effective_month, seat_type,
--      source): a person's seat type for month M is the row with the latest
--      effective_month <= M; 'none' means unassigned (no billed seat). source
--      is 'roster' for a CSV import, 'admin' for an edit on /admin/org.
--
--   3. set_cursor_seat_assignments(p_rows, p_from_month, p_source, p_set_by)
--      and set_cursor_seat_rate(p_seat_type, p_from_month, p_rate, p_set_by):
--      the write paths. "From month M onward": rows effective after M are
--      removed and the M row is upserted, so months before M never change.
--      Atomic, SECURITY INVOKER, pinned search_path, EXECUTE for
--      service_role only (the admin routes).
--
-- RLS on both tables; authenticated may SELECT (the dashboard reads them with
-- the user's client, like recurring_costs); writes are service_role only.
--
-- The app degrades safely while this migration is not applied: a missing
-- table reads as "no seat assignments" (Cursor totals unchanged) and the
-- Cursor seats card on /admin/org shows a "migration 026 not applied" notice
-- with edits disabled.
--
-- A person deleted from people (including a duplicate merged away by 021)
-- loses their assignment rows (ON DELETE CASCADE); re-assign on the person
-- they were merged into.
--
-- Idempotent: safe to re-run.
--
-- Rollback (removes every seat assignment and rate; Cursor totals go back to
-- on-demand usage only; cost_records is unaffected):
--   DROP FUNCTION IF EXISTS public.set_cursor_seat_assignments(JSONB, DATE, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS public.set_cursor_seat_rate(TEXT, DATE, NUMERIC, TEXT);
--   DROP TABLE IF EXISTS public.cursor_seat_assignments;
--   DROP TABLE IF EXISTS public.cursor_seat_rates;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Rates
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cursor_seat_rates (
    seat_type TEXT NOT NULL,
    effective_month DATE NOT NULL,
    monthly_rate_usd NUMERIC(12, 2) NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (seat_type, effective_month),
    CONSTRAINT cursor_seat_rates_type CHECK (seat_type IN ('standard', 'premium', 'free')),
    CONSTRAINT cursor_seat_rates_is_month CHECK (effective_month = date_trunc('month', effective_month)::date),
    CONSTRAINT cursor_seat_rates_nonnegative CHECK (monthly_rate_usd >= 0)
);

COMMENT ON TABLE public.cursor_seat_rates IS
    'Monthly Cursor seat rate per seat type; the rate for month M is the latest effective_month <= M';

INSERT INTO public.cursor_seat_rates (seat_type, effective_month, monthly_rate_usd, updated_by)
VALUES ('standard', DATE '2000-01-01', 40.00, 'migration 026'),
       ('premium',  DATE '2000-01-01', 80.00, 'migration 026'),
       ('free',     DATE '2000-01-01',  0.00, 'migration 026')
ON CONFLICT (seat_type, effective_month) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Assignments
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cursor_seat_assignments (
    person_id UUID NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
    effective_month DATE NOT NULL,
    seat_type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'admin',
    set_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (person_id, effective_month),
    CONSTRAINT cursor_seat_assignments_type CHECK (seat_type IN ('standard', 'premium', 'free', 'none')),
    CONSTRAINT cursor_seat_assignments_source CHECK (source IN ('admin', 'roster')),
    CONSTRAINT cursor_seat_assignments_is_month CHECK (effective_month = date_trunc('month', effective_month)::date)
);

CREATE INDEX IF NOT EXISTS idx_cursor_seat_assignments_month
    ON public.cursor_seat_assignments (effective_month);

COMMENT ON TABLE public.cursor_seat_assignments IS
    'Cursor seat type per person; the type for month M is the latest effective_month <= M; none = unassigned';

-- ----------------------------------------------------------------------------
-- 3. Access
-- ----------------------------------------------------------------------------
ALTER TABLE public.cursor_seat_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cursor_seat_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can view cursor seat rates" ON public.cursor_seat_rates;
CREATE POLICY "Authenticated can view cursor seat rates"
    ON public.cursor_seat_rates FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated can view cursor seat assignments" ON public.cursor_seat_assignments;
CREATE POLICY "Authenticated can view cursor seat assignments"
    ON public.cursor_seat_assignments FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.cursor_seat_rates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cursor_seat_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cursor_seat_rates TO authenticated;
GRANT SELECT ON public.cursor_seat_assignments TO authenticated;
GRANT ALL ON public.cursor_seat_rates TO service_role;
GRANT ALL ON public.cursor_seat_assignments TO service_role;

-- ----------------------------------------------------------------------------
-- 4. Write paths
-- ----------------------------------------------------------------------------

-- p_rows: [{ "person_id": uuid, "seat_type": "standard"|"premium"|"free"|"none" }, ...]
-- Sets each person's type from p_from_month onward. All or nothing.
CREATE OR REPLACE FUNCTION public.set_cursor_seat_assignments(
    p_rows JSONB,
    p_from_month DATE,
    p_source TEXT,
    p_set_by TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_from DATE;
    v_n INTEGER;
    v_bad INTEGER;
    v_dup INTEGER;
    v_missing INTEGER;
BEGIN
    IF p_from_month IS NULL THEN
        RAISE EXCEPTION 'set_cursor_seat_assignments: month is required';
    END IF;
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
        RAISE EXCEPTION 'set_cursor_seat_assignments: no rows';
    END IF;
    v_from := date_trunc('month', p_from_month)::date;

    SELECT count(*) FILTER (WHERE x.person_id IS NULL
                               OR x.seat_type IS NULL
                               OR x.seat_type NOT IN ('standard', 'premium', 'free', 'none')),
           count(*) - count(DISTINCT x.person_id),
           count(*) FILTER (WHERE x.person_id IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id = x.person_id))
      INTO v_bad, v_dup, v_missing
      FROM jsonb_to_recordset(p_rows) AS x(person_id UUID, seat_type TEXT);
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'set_cursor_seat_assignments: % rows have no person or an unknown seat type', v_bad;
    END IF;
    IF v_dup > 0 THEN
        RAISE EXCEPTION 'set_cursor_seat_assignments: a person appears more than once';
    END IF;
    IF v_missing > 0 THEN
        RAISE EXCEPTION 'set_cursor_seat_assignments: % people not found', v_missing;
    END IF;

    -- Serialize edits of the same people.
    PERFORM 1 FROM people
     WHERE id IN (SELECT x.person_id FROM jsonb_to_recordset(p_rows) AS x(person_id UUID))
     ORDER BY id FOR UPDATE;

    DELETE FROM cursor_seat_assignments a
     USING jsonb_to_recordset(p_rows) AS x(person_id UUID)
     WHERE a.person_id = x.person_id AND a.effective_month > v_from;

    INSERT INTO cursor_seat_assignments (person_id, effective_month, seat_type, source, set_by, updated_at)
    SELECT x.person_id, v_from, x.seat_type, COALESCE(NULLIF(p_source, ''), 'admin'), NULLIF(p_set_by, ''), NOW()
      FROM jsonb_to_recordset(p_rows) AS x(person_id UUID, seat_type TEXT)
    ON CONFLICT (person_id, effective_month) DO UPDATE
       SET seat_type = EXCLUDED.seat_type,
           source = EXCLUDED.source,
           set_by = EXCLUDED.set_by,
           updated_at = NOW();
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;

COMMENT ON FUNCTION public.set_cursor_seat_assignments(JSONB, DATE, TEXT, TEXT) IS
    'Set Cursor seat types for people from a month onward; earlier months are unchanged';

REVOKE ALL ON FUNCTION public.set_cursor_seat_assignments(JSONB, DATE, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_cursor_seat_assignments(JSONB, DATE, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.set_cursor_seat_rate(
    p_seat_type TEXT,
    p_from_month DATE,
    p_rate NUMERIC,
    p_set_by TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_from DATE;
BEGIN
    IF p_seat_type IS NULL OR p_seat_type NOT IN ('standard', 'premium', 'free') THEN
        RAISE EXCEPTION 'set_cursor_seat_rate: unknown seat type %', p_seat_type;
    END IF;
    IF p_from_month IS NULL THEN
        RAISE EXCEPTION 'set_cursor_seat_rate: month is required';
    END IF;
    IF p_rate IS NULL OR p_rate < 0 THEN
        RAISE EXCEPTION 'set_cursor_seat_rate: rate must be >= 0';
    END IF;
    v_from := date_trunc('month', p_from_month)::date;

    PERFORM pg_advisory_xact_lock(hashtext('cursor_seat_rates:' || p_seat_type));

    DELETE FROM cursor_seat_rates WHERE seat_type = p_seat_type AND effective_month > v_from;
    INSERT INTO cursor_seat_rates (seat_type, effective_month, monthly_rate_usd, updated_by, updated_at)
    VALUES (p_seat_type, v_from, round(p_rate, 2), NULLIF(p_set_by, ''), NOW())
    ON CONFLICT (seat_type, effective_month) DO UPDATE
       SET monthly_rate_usd = EXCLUDED.monthly_rate_usd,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW();
END $$;

COMMENT ON FUNCTION public.set_cursor_seat_rate(TEXT, DATE, NUMERIC, TEXT) IS
    'Set a Cursor seat type''s monthly rate from a month onward; earlier months are unchanged';

REVOKE ALL ON FUNCTION public.set_cursor_seat_rate(TEXT, DATE, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_cursor_seat_rate(TEXT, DATE, NUMERIC, TEXT) TO service_role;
