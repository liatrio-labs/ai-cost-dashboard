-- ============================================================================
-- Migration 024: invoice actuals per provider + calendar month (issue #75)
-- ----------------------------------------------------------------------------
-- Usage APIs can disagree with what a vendor actually bills (e.g. Cursor
-- usage accrued as "Included in Business" during an Enterprise trial). An
-- admin can record the invoiced amount for one provider and one calendar
-- month; the dashboard then reports exactly that amount for the
-- provider-month.
--
-- Nothing is written to cost_records. The app applies overrides at read time
-- (frontend/lib/invoice-overrides.ts): the provider-month's API rows are kept
-- for per-person / per-team / per-product attribution and scaled
-- proportionally so they sum to the invoiced amount; the provider-month's
-- manual entries and recurring costs are dropped (the invoice replaces them).
-- A provider-month with no API spend to scale gets one org-level
-- "invoice adjustment" row instead.
--
-- This migration adds:
--
--   invoice_overrides: one row per (provider_id, month). month is the 1st of
--   the calendar month. billed_amount_usd is the amount that counts (what the
--   invoices for the month total, net of any credits). credits_usd, notes and
--   invoice_ids are informational. entered_by is the admin's email,
--   entered_at the time of the last set. RLS on; authenticated may SELECT
--   (the dashboard reads it with the user's client, like recurring_costs);
--   writes are service_role only (the admin route, behind requireAdmin).
--
-- No other table or data is touched. The app degrades safely while this
-- migration is not applied: a missing invoice_overrides table means "no
-- overrides" (dashboard totals unchanged), and the Invoice actuals section on
-- /admin shows a "migration 024 not applied" notice with writes disabled.
--
-- Idempotent: safe to re-run.
--
-- Rollback (removes every invoice override; the dashboard goes back to API,
-- manual and recurring amounts for those months):
--   DROP TABLE IF EXISTS public.invoice_overrides;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.invoice_overrides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
    month DATE NOT NULL,
    billed_amount_usd NUMERIC(12, 2) NOT NULL,
    credits_usd NUMERIC(12, 2),
    notes TEXT,
    invoice_ids TEXT[] NOT NULL DEFAULT '{}',
    entered_by TEXT,
    entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT invoice_overrides_provider_month_key UNIQUE (provider_id, month),
    CONSTRAINT invoice_overrides_month_is_month CHECK (month = date_trunc('month', month)::date),
    CONSTRAINT invoice_overrides_billed_nonnegative CHECK (billed_amount_usd >= 0),
    CONSTRAINT invoice_overrides_credits_nonnegative CHECK (credits_usd IS NULL OR credits_usd >= 0)
);

COMMENT ON TABLE public.invoice_overrides IS
    'Invoiced amount per provider + calendar month (issue #75); replaces API, manual and recurring spend for that provider-month at read time';
COMMENT ON COLUMN public.invoice_overrides.month IS '1st of the calendar month the invoice amount covers';
COMMENT ON COLUMN public.invoice_overrides.billed_amount_usd IS 'Amount that counts for the provider-month (invoice total, net of credits)';
COMMENT ON COLUMN public.invoice_overrides.credits_usd IS 'Informational: credits already netted out of billed_amount_usd';
COMMENT ON COLUMN public.invoice_overrides.entered_by IS 'Email of the admin who last set this row';

ALTER TABLE public.invoice_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can view invoice overrides" ON public.invoice_overrides;
CREATE POLICY "Authenticated can view invoice overrides"
    ON public.invoice_overrides FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.invoice_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invoice_overrides TO authenticated;
GRANT ALL ON public.invoice_overrides TO service_role;
