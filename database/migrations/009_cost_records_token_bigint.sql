-- ============================================================================
-- Migration 009: Widen cost_records token/request columns to BIGINT
-- ----------------------------------------------------------------------------
-- Claude.ai org-wide daily token totals exceed PostgreSQL INTEGER
-- (max 2,147,483,647). A manual pull failed with:
--   value "2150834517" is out of range for type integer
--
-- Applies to the partitioned parent; PostgreSQL rewrites every partition.
-- Idempotent: ALTER TYPE bigint on a bigint column is a no-op.
-- ============================================================================

ALTER TABLE cost_records
    ALTER COLUMN tokens_used TYPE BIGINT,
    ALTER COLUMN input_tokens TYPE BIGINT,
    ALTER COLUMN output_tokens TYPE BIGINT,
    ALTER COLUMN request_count TYPE BIGINT;
