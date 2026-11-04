-- ============================================================================
-- Migration 022: recurring monthly costs for licenses and flat-fee tools
-- (issue #59)
-- ----------------------------------------------------------------------------
-- A recurring cost is a monthly amount for one provider (Claude Ultra,
-- Lovable, ChatGPT Business, ...) that counts for every month from
-- start_month through end_month (or, open-ended, through the current month)
-- without anyone entering it. A change "from month M onward" ends the segment
-- covering M at M - 1 and starts a new segment at M, so months before M are
-- never changed. A provider's segments never overlap (trigger below).
--
-- Nothing is written to cost_records: the app expands the segments into
-- synthetic monthly rows at read time (frontend/lib/recurring-costs.ts), and
-- a provider-month that already has a manual entry (manual_entry/csv_import)
-- keeps that entry instead, so there is no double counting and no past month
-- is backfilled or altered. cost_records, cost_records_daily and
-- cost_records_daily_attributed are not touched by this migration.
--
-- This migration adds:
--
--   1. recurring_costs: one row per segment. monthly_cost_usd is the amount;
--      seats and price_per_seat are both set (amount = seats x price) or
--      both NULL (flat fee). Months are stored as the 1st of the month.
--      RLS on; authenticated may SELECT (the dashboard reads it like the org
--      tables), writes are service_role only (the admin route).
--
--   2. recurring_costs_no_overlap trigger: refuses a segment that overlaps
--      another segment of the same provider.
--
--   3. set_recurring_cost(...): the one write path. Atomically applies
--      "from p_from_month onward": deletes segments starting at or after it,
--      ends the segment covering it at the month before, and (unless
--      p_monthly_cost_usd is NULL, which means "end the recurring cost")
--      inserts the new segment. SECURITY INVOKER, pinned search_path,
--      EXECUTE for service_role only.
--
-- The app degrades safely while this migration is not applied: reads of a
-- missing recurring_costs table are treated as "no recurring costs" and the
-- admin writes answer with an explanatory error.
--
-- Idempotent: safe to re-run.
--
-- Rollback (removes every recurring cost; cost_records is unaffected, so the
-- dashboard goes back to manual entries only):
--   DROP FUNCTION IF EXISTS public.set_recurring_cost(UUID, DATE, NUMERIC, INTEGER, NUMERIC, DATE, TEXT, UUID);
--   DROP TABLE IF EXISTS public.recurring_costs;   -- drops its trigger too
--   DROP FUNCTION IF EXISTS public.recurring_costs_check_overlap();
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_costs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
    start_month DATE NOT NULL,
    end_month DATE,
    monthly_cost_usd NUMERIC(12, 2) NOT NULL,
    seats INTEGER,
    price_per_seat NUMERIC(12, 2),
    notes TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT recurring_costs_start_is_month CHECK (start_month = date_trunc('month', start_month)::date),
    CONSTRAINT recurring_costs_end_is_month CHECK (end_month IS NULL OR end_month = date_trunc('month', end_month)::date),
    CONSTRAINT recurring_costs_end_after_start CHECK (end_month IS NULL OR end_month >= start_month),
    CONSTRAINT recurring_costs_cost_nonnegative CHECK (monthly_cost_usd >= 0),
    CONSTRAINT recurring_costs_seats_pair CHECK ((seats IS NULL) = (price_per_seat IS NULL)),
    CONSTRAINT recurring_costs_seats_positive CHECK (seats IS NULL OR seats >= 1),
    CONSTRAINT recurring_costs_price_nonnegative CHECK (price_per_seat IS NULL OR price_per_seat >= 0),
    CONSTRAINT recurring_costs_seat_amount CHECK (seats IS NULL OR monthly_cost_usd = round(seats * price_per_seat, 2))
);

CREATE INDEX IF NOT EXISTS idx_recurring_costs_provider_start
    ON public.recurring_costs (provider_id, start_month);

COMMENT ON TABLE public.recurring_costs IS
    'Recurring monthly cost segments per provider (issue #59); expanded into monthly spend at read time, overridden by a manual entry for the same month';
COMMENT ON COLUMN public.recurring_costs.end_month IS
    'Last month (1st of month) the segment counts for; NULL = open-ended';
COMMENT ON COLUMN public.recurring_costs.monthly_cost_usd IS
    'Monthly amount; equals round(seats * price_per_seat, 2) when seats are set';

-- ----------------------------------------------------------------------------
-- 2. No overlapping segments per provider
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recurring_costs_check_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM recurring_costs r
         WHERE r.provider_id = NEW.provider_id
           AND r.id <> NEW.id
           AND r.start_month <= COALESCE(NEW.end_month, 'infinity'::date)
           AND NEW.start_month <= COALESCE(r.end_month, 'infinity'::date)
    ) THEN
        RAISE EXCEPTION 'recurring_costs: segment % to % overlaps another segment of this provider',
            NEW.start_month, COALESCE(NEW.end_month::text, 'open')
            USING ERRCODE = 'exclusion_violation';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recurring_costs_no_overlap ON public.recurring_costs;
CREATE TRIGGER recurring_costs_no_overlap
    BEFORE INSERT OR UPDATE ON public.recurring_costs
    FOR EACH ROW EXECUTE FUNCTION public.recurring_costs_check_overlap();

REVOKE ALL ON FUNCTION public.recurring_costs_check_overlap() FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Access
-- ----------------------------------------------------------------------------
ALTER TABLE public.recurring_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can view recurring costs" ON public.recurring_costs;
CREATE POLICY "Authenticated can view recurring costs"
    ON public.recurring_costs FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.recurring_costs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.recurring_costs TO authenticated;
GRANT ALL ON public.recurring_costs TO service_role;

-- ----------------------------------------------------------------------------
-- 4. The write path: change (or end) from a month onward
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_recurring_cost(
    p_provider_id UUID,
    p_from_month DATE,
    p_monthly_cost_usd NUMERIC,
    p_seats INTEGER,
    p_price_per_seat NUMERIC,
    p_end_month DATE,
    p_notes TEXT,
    p_created_by UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_from DATE;
    v_id UUID;
BEGIN
    IF p_provider_id IS NULL OR p_from_month IS NULL THEN
        RAISE EXCEPTION 'set_recurring_cost: provider and month are required';
    END IF;
    v_from := date_trunc('month', p_from_month)::date;

    -- Serialize edits of one provider's segments.
    PERFORM 1 FROM providers WHERE id = p_provider_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'set_recurring_cost: provider % not found', p_provider_id;
    END IF;

    DELETE FROM recurring_costs WHERE provider_id = p_provider_id AND start_month >= v_from;
    UPDATE recurring_costs
       SET end_month = (v_from - INTERVAL '1 month')::date
     WHERE provider_id = p_provider_id
       AND start_month < v_from
       AND (end_month IS NULL OR end_month >= v_from);

    IF p_monthly_cost_usd IS NULL THEN
        RETURN NULL; -- ended from v_from onward
    END IF;

    INSERT INTO recurring_costs (provider_id, start_month, end_month, monthly_cost_usd,
                                 seats, price_per_seat, notes, created_by)
    VALUES (p_provider_id, v_from,
            CASE WHEN p_end_month IS NULL THEN NULL ELSE date_trunc('month', p_end_month)::date END,
            p_monthly_cost_usd, p_seats, p_price_per_seat, NULLIF(p_notes, ''), p_created_by)
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

COMMENT ON FUNCTION public.set_recurring_cost(UUID, DATE, NUMERIC, INTEGER, NUMERIC, DATE, TEXT, UUID) IS
    'Set (or, with a NULL amount, end) a provider''s recurring monthly cost from a month onward; earlier months are unchanged (issue #59)';

REVOKE ALL ON FUNCTION public.set_recurring_cost(UUID, DATE, NUMERIC, INTEGER, NUMERIC, DATE, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_recurring_cost(UUID, DATE, NUMERIC, INTEGER, NUMERIC, DATE, TEXT, UUID) TO service_role;
