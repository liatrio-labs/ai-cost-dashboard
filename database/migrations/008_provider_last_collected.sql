-- ============================================================================
-- Migration 008: providers.last_collected_at
-- ----------------------------------------------------------------------------
-- Tracks when each tool's data was last written — set on every successful cron
-- pull and on manual entry inserts. Surfaced as a "Last updated" column on the
-- dashboard Providers table. Backfilled from the latest cost_record per provider.
--
-- Idempotent: safe to re-run.
-- ============================================================================

ALTER TABLE providers ADD COLUMN IF NOT EXISTS last_collected_at TIMESTAMPTZ;

UPDATE providers p
SET last_collected_at = sub.maxc
FROM (
  SELECT provider_id, MAX(created_at) AS maxc
  FROM cost_records
  GROUP BY provider_id
) sub
WHERE p.id = sub.provider_id
  AND p.last_collected_at IS NULL;
