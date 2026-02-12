-- Enable TimescaleDB compression and create retention policies
-- Run this after enabling TimescaleDB extension

-- ============================================================================
-- COMPRESSION POLICIES
-- ============================================================================

-- Enable compression on cost_records partitions
-- Compress data older than 7 days (balance query performance and storage)
SELECT add_compression_policy('cost_records', INTERVAL '7 days');

-- Set compression chunk interval to 1 month
SELECT set_chunk_time_interval('cost_records', INTERVAL '1 month');

-- ============================================================================
-- RETENTION POLICIES
-- ============================================================================

-- Raw data retention: 1 year
-- After 1 year, raw granular data is dropped
SELECT add_retention_policy('cost_records', INTERVAL '1 year');

-- ============================================================================
-- CONTINUOUS AGGREGATES FOR PERFORMANCE
-- ============================================================================

-- Hourly aggregates (kept for 2 years)
CREATE MATERIALIZED VIEW cost_records_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', timestamp) AS hour,
    user_id,
    provider_id,
    model_name,
    SUM(cost_usd) AS total_cost_usd,
    SUM(tokens_used) AS total_tokens,
    SUM(input_tokens) AS total_input_tokens,
    SUM(output_tokens) AS total_output_tokens,
    SUM(request_count) AS total_requests,
    COUNT(*) AS record_count
FROM cost_records
GROUP BY hour, user_id, provider_id, model_name;

COMMENT ON MATERIALIZED VIEW cost_records_hourly IS 'Hourly cost aggregates for faster queries';

-- Add compression policy for hourly aggregates (compress after 30 days)
SELECT add_compression_policy('cost_records_hourly', INTERVAL '30 days');

-- Add retention policy for hourly aggregates (keep 2 years)
SELECT add_retention_policy('cost_records_hourly', INTERVAL '2 years');

-- Create refresh policy (refresh every 15 minutes)
SELECT add_continuous_aggregate_policy('cost_records_hourly',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '15 minutes');

-- ============================================================================
-- DAILY AGGREGATES (kept forever for historical analysis)
-- ============================================================================

-- Note: The existing cost_records_daily materialized view is already created
-- in the main schema. We'll add policies to it.

-- Add index for faster queries on daily aggregates
CREATE INDEX IF NOT EXISTS cost_records_daily_user_provider_date_idx
    ON cost_records_daily (user_id, provider_id, date DESC);

-- ============================================================================
-- QUERY OPTIMIZATION INDEXES
-- ============================================================================

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS cost_records_user_timestamp_cost_idx
    ON cost_records (user_id, timestamp DESC, cost_usd);

CREATE INDEX IF NOT EXISTS cost_records_provider_model_timestamp_idx
    ON cost_records (provider_id, model_name, timestamp DESC);

-- Partial indexes for filtering
CREATE INDEX IF NOT EXISTS cost_records_recent_idx
    ON cost_records (timestamp DESC)
    WHERE timestamp > NOW() - INTERVAL '30 days';

-- ============================================================================
-- VACUUM AND ANALYZE
-- ============================================================================

-- Analyze tables to update statistics
ANALYZE cost_records;
ANALYZE cost_records_daily;
ANALYZE forecast_results;
ANALYZE api_credentials;

-- Vacuum to reclaim space
VACUUM ANALYZE cost_records;

-- ============================================================================
-- CONNECTION POOLING SETTINGS
-- ============================================================================

-- These settings should be applied in PostgreSQL configuration
-- or via Supabase dashboard settings

-- Recommended settings for connection pooling:
-- max_connections = 100
-- shared_buffers = 256MB (or 25% of RAM)
-- effective_cache_size = 1GB (or 50% of RAM)
-- maintenance_work_mem = 128MB
-- work_mem = 16MB
-- min_wal_size = 1GB
-- max_wal_size = 4GB
-- checkpoint_completion_target = 0.9
-- wal_buffers = 16MB
-- default_statistics_target = 100

-- ============================================================================
-- COMPLETION MESSAGE
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '============================================================';
    RAISE NOTICE 'Compression and retention policies enabled successfully';
    RAISE NOTICE 'Raw data: 1 year retention, compressed after 7 days';
    RAISE NOTICE 'Hourly aggregates: 2 years retention, compressed after 30 days';
    RAISE NOTICE 'Daily aggregates: Forever retention (no compression needed)';
    RAISE NOTICE 'Continuous aggregates refresh every 15 minutes';
    RAISE NOTICE '============================================================';
END $$;
