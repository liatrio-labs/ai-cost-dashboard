-- ============================================================================
-- Migration 020: Monthly budgets and alert log (issue #49)
-- ----------------------------------------------------------------------------
-- 1. budgets  one monthly budget (USD) per person, team or project:
--
--      scope        person | team | project
--      subject_id   people.id | teams.id | org_projects.id (no FK: the target
--                   table depends on scope; a budget whose subject was
--                   deleted is listed as "deleted" and never alerts)
--      monthly_usd  > 0
--      note         optional free text
--      created_by / updated_by   admin email
--
--    One budget per (scope, subject_id): saving again replaces it. The
--    "projected over budget" flag compares the #39 current-month projection
--    (frontend/lib/projection.ts) with monthly_usd; nothing is stored.
--
-- 2. alert_log  one row per alert sent (or, in dry-run mode, logged), so an
--    alert goes out at most once per subject per month:
--
--      subject   person:<id> | team:<id> | project:<id>
--      period    YYYY-MM the alert is about
--      kinds     what fired: projected_overrun and/or spike
--      dry_run   true when logged in dry-run mode (nothing sent). Dry-run and
--                live rows are deduped separately, so switching to live still
--                sends this month's alerts once.
--      channels  where it went (slack, email); empty in dry-run
--      amount / budget_usd   the projected amount and budget at send time
--      message   the text that was (or would have been) sent
--
--    UNIQUE (subject, period, dry_run): the cron claims the row before it
--    sends, so two overlapping runs can't both send.
--
-- 3. review_items.kind gains 'budget_over' (when migration 018 is applied) so
--    the Needs-review inbox can record Acknowledge on budget items.
--
-- Nothing here changes cost_records or cost_records_daily_attributed, so
-- attribution and totals are identical before and after. The app works
-- without this migration: the Budgets tab shows "migration 020 not applied",
-- the inbox has no budget items and the alert cron sends nothing.
--
-- Access: both tables are admin-only. RLS is on with no policies and anon /
-- authenticated have no grants; the admin routes and the cron use the
-- service role. Idempotent: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS budgets (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scope        VARCHAR(10)    NOT NULL,
    subject_id   UUID           NOT NULL,
    monthly_usd  NUMERIC(14, 2) NOT NULL,
    note         TEXT,
    created_by   TEXT,
    updated_by   TEXT,
    created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_scope_check;
ALTER TABLE budgets ADD CONSTRAINT budgets_scope_check
    CHECK (scope IN ('person', 'team', 'project'));
ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_monthly_usd_check;
ALTER TABLE budgets ADD CONSTRAINT budgets_monthly_usd_check
    CHECK (monthly_usd > 0);

CREATE UNIQUE INDEX IF NOT EXISTS budgets_scope_subject_key
    ON budgets (scope, subject_id);

COMMENT ON TABLE budgets IS
    'Monthly budgets per person / team / project (issue #49). Admin-only (service role).';

CREATE TABLE IF NOT EXISTS alert_log (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject     TEXT           NOT NULL,
    period      VARCHAR(7)     NOT NULL,
    kinds       TEXT[]         NOT NULL DEFAULT '{}',
    dry_run     BOOLEAN        NOT NULL DEFAULT TRUE,
    channels    TEXT[]         NOT NULL DEFAULT '{}',
    amount      NUMERIC(14, 2),
    budget_usd  NUMERIC(14, 2),
    message     TEXT,
    sent_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

ALTER TABLE alert_log DROP CONSTRAINT IF EXISTS alert_log_period_check;
ALTER TABLE alert_log ADD CONSTRAINT alert_log_period_check
    CHECK (period ~ '^[0-9]{4}-[0-9]{2}$');
ALTER TABLE alert_log DROP CONSTRAINT IF EXISTS alert_log_subject_check;
ALTER TABLE alert_log ADD CONSTRAINT alert_log_subject_check
    CHECK (subject ~ '^(person|team|project):.+$');
ALTER TABLE alert_log DROP CONSTRAINT IF EXISTS alert_log_kinds_check;
ALTER TABLE alert_log ADD CONSTRAINT alert_log_kinds_check
    CHECK (kinds <@ ARRAY['projected_overrun', 'spike']::TEXT[]);

CREATE UNIQUE INDEX IF NOT EXISTS alert_log_subject_period_dry_run_key
    ON alert_log (subject, period, dry_run);

COMMENT ON TABLE alert_log IS
    'Budget / spike alerts sent (or logged in dry-run), at most once per subject per month (issue #49). Admin-only (service role).';

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.budgets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.budgets TO service_role;

ALTER TABLE alert_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.alert_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.alert_log TO service_role;

-- Needs-review inbox: allow Acknowledge on budget items (only if 018 is applied).
DO $$
BEGIN
    IF to_regclass('public.review_items') IS NOT NULL THEN
        ALTER TABLE review_items DROP CONSTRAINT IF EXISTS review_items_kind_check;
        ALTER TABLE review_items ADD CONSTRAINT review_items_kind_check
            CHECK (kind IN ('person_spike', 'person_day', 'unassigned_new', 'key_new', 'budget_over'));
    END IF;
END
$$;
