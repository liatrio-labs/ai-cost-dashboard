-- ============================================================================
-- Migration 009: Widen cost_records token/request columns to BIGINT
-- ----------------------------------------------------------------------------
-- Claude.ai org-wide daily token totals exceed PostgreSQL INTEGER
-- (max 2,147,483,647). A manual pull failed with:
--   value "2150834517" is out of range for type integer
--
-- cost_records_daily (and optional cost_records_hourly) pin those columns, so
-- they must be dropped before ALTER TYPE and recreated afterward.
--
-- Idempotent: ALTER TYPE bigint on a bigint column is a no-op; DROP IF EXISTS
-- + CREATE is safe to re-run.
-- ============================================================================

DROP MATERIALIZED VIEW IF EXISTS cost_records_hourly;
DROP MATERIALIZED VIEW IF EXISTS cost_records_daily;

ALTER TABLE cost_records
    ALTER COLUMN tokens_used TYPE BIGINT,
    ALTER COLUMN input_tokens TYPE BIGINT,
    ALTER COLUMN output_tokens TYPE BIGINT,
    ALTER COLUMN request_count TYPE BIGINT;

CREATE MATERIALIZED VIEW cost_records_daily AS
SELECT
    user_id,
    provider_id,
    DATE(timestamp) AS date,
    model_name,
    SUM(cost_usd) AS total_cost_usd,
    SUM(tokens_used) AS total_tokens,
    SUM(input_tokens) AS total_input_tokens,
    SUM(output_tokens) AS total_output_tokens,
    SUM(request_count) AS total_requests,
    COUNT(*) AS record_count
FROM cost_records
GROUP BY user_id, provider_id, DATE(timestamp), model_name;

COMMENT ON MATERIALIZED VIEW cost_records_daily IS 'Daily aggregated costs for improved query performance';

CREATE UNIQUE INDEX cost_records_daily_unique_idx
    ON cost_records_daily (user_id, provider_id, date, model_name);

CREATE INDEX cost_records_daily_user_date_idx
    ON cost_records_daily (user_id, date DESC);

CREATE INDEX cost_records_daily_date_idx
    ON cost_records_daily (date DESC);

CREATE INDEX IF NOT EXISTS cost_records_daily_user_provider_date_idx
    ON cost_records_daily (user_id, provider_id, date DESC);

GRANT SELECT ON cost_records_daily TO authenticated, service_role;
