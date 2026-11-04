-- ============================================================================
-- Migration 018: Needs-review inbox and provider key creation dates (issue #44)
-- ----------------------------------------------------------------------------
-- 1. org_api_keys.provider_created_at  when the provider created the key
--    (Anthropic Admin API created_at, OpenAI admin project keys created_at,
--    Vercel AI Gateway createdAt). NULL = unknown; the key syncs fill it in
--    when the provider reports it. created_at stays our own row date.
--
-- 2. review_items  what an admin did with an item in the "Needs review" inbox
--    (frontend/lib/org/review-inbox.ts). The inbox itself is computed live
--    from cost_records_daily_attributed; this table only records decisions:
--
--      kind        person_spike | person_day | unassigned_new | key_new
--      subject     what the item is about: a people.id, an org_api_keys.id or
--                  an Unassigned group key (person:<email>, api_key:<id>, ...)
--      period      YYYY-MM for spikes, YYYY-MM-DD for days / first-seen dates
--      amount      the item's amount when it was acknowledged / assigned; the
--                  item stays hidden until the live amount grows past 1.25x
--      status      acknowledged | assigned
--      note        optional free text
--      acknowledged_by / acknowledged_at   who decided, and when
--
--    One row per (kind, subject, period): acknowledging again replaces it.
--
-- Nothing here changes cost_records or cost_records_daily_attributed, so
-- attribution and totals are identical before and after. The app works
-- without this migration: the inbox still lists items (no Acknowledge, with a
-- "migration 018 not applied" notice) and creation dates read as unknown.
--
-- Access: review_items is admin-only. RLS is on with no policies and anon /
-- authenticated have no grants; the admin routes use the service role.
-- org_api_keys keeps 010's policy and grants (ADD COLUMN doesn't change them).
-- Idempotent: safe to re-run.
-- ============================================================================

ALTER TABLE org_api_keys
    ADD COLUMN IF NOT EXISTS provider_created_at TIMESTAMPTZ;

COMMENT ON COLUMN org_api_keys.provider_created_at IS
    'When the provider created the key (Anthropic / OpenAI created_at, Vercel createdAt), as last synced. NULL = unknown';

CREATE TABLE IF NOT EXISTS review_items (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind             VARCHAR(20)   NOT NULL,
    subject          TEXT          NOT NULL,
    period           VARCHAR(10)   NOT NULL,
    amount           NUMERIC(14, 2) NOT NULL DEFAULT 0,
    status           VARCHAR(20)   NOT NULL DEFAULT 'acknowledged',
    note             TEXT,
    acknowledged_by  TEXT,
    acknowledged_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE review_items DROP CONSTRAINT IF EXISTS review_items_kind_check;
ALTER TABLE review_items ADD CONSTRAINT review_items_kind_check
    CHECK (kind IN ('person_spike', 'person_day', 'unassigned_new', 'key_new'));
ALTER TABLE review_items DROP CONSTRAINT IF EXISTS review_items_status_check;
ALTER TABLE review_items ADD CONSTRAINT review_items_status_check
    CHECK (status IN ('acknowledged', 'assigned'));
ALTER TABLE review_items DROP CONSTRAINT IF EXISTS review_items_period_check;
ALTER TABLE review_items ADD CONSTRAINT review_items_period_check
    CHECK (period ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$');
ALTER TABLE review_items DROP CONSTRAINT IF EXISTS review_items_amount_check;
ALTER TABLE review_items ADD CONSTRAINT review_items_amount_check
    CHECK (amount >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS review_items_kind_subject_period_key
    ON review_items (kind, subject, period);

COMMENT ON TABLE review_items IS
    'Needs-review inbox decisions (issue #44): one row per acknowledged / assigned item. Admin-only (service role).';

ALTER TABLE review_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.review_items TO service_role;
