-- ============================================================================
-- Migration 017: Anthropic key sync columns (issue #32)
-- ----------------------------------------------------------------------------
-- The Anthropic key sync (frontend/lib/org/anthropic-key-sync.ts) registers
-- every Admin API key in org_api_keys and assigns it to its creator. Two
-- things it must store have no 015 column:
--
--   org_api_keys.external_status    the provider's key status
--                                   (Anthropic: active | inactive | archived)
--   org_api_keys.unresolved_reason  why the sync could not give the key an
--                                   owner: no_creator | service_account |
--                                   deleted_user | unmatched_creator.
--                                   NULL when the key has an owner or was
--                                   never looked at.
--
-- Both are plain metadata: nothing here changes cost_records_daily_attributed,
-- so attribution and totals are identical before and after. The app reads and
-- writes these columns only when they exist (it falls back to the 015 column
-- set), so deploying the code before this migration is safe.
--
-- Access is unchanged (org_api_keys keeps 010's RLS policy and grants; ADD
-- COLUMN does not change them). Idempotent: safe to re-run.
-- ============================================================================

ALTER TABLE org_api_keys
    ADD COLUMN IF NOT EXISTS external_status VARCHAR(20),
    ADD COLUMN IF NOT EXISTS unresolved_reason VARCHAR(30);

ALTER TABLE org_api_keys DROP CONSTRAINT IF EXISTS org_api_keys_unresolved_reason_check;
ALTER TABLE org_api_keys ADD CONSTRAINT org_api_keys_unresolved_reason_check
    CHECK (unresolved_reason IS NULL
           OR unresolved_reason IN ('no_creator', 'service_account', 'deleted_user', 'unmatched_creator'));

COMMENT ON COLUMN org_api_keys.external_status IS
    'Provider key status as last synced (Anthropic: active, inactive, archived). NULL = unknown';
COMMENT ON COLUMN org_api_keys.unresolved_reason IS
    'Why the key sync left the key without an owner: no_creator, service_account, deleted_user, unmatched_creator. NULL = resolved or not synced';
