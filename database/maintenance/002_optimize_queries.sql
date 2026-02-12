-- Query optimization and performance tuning
-- Run this periodically for optimal performance

-- ============================================================================
-- EXPLAIN ANALYZE COMMON QUERIES
-- ============================================================================

-- These queries help identify slow operations
-- Run them to check performance, then optimize as needed

-- Query 1: User total spend (most common)
EXPLAIN ANALYZE
SELECT
    user_id,
    SUM(cost_usd) AS total_cost
FROM cost_records
WHERE user_id = 'sample-user-id'
    AND timestamp >= NOW() - INTERVAL '30 days'
GROUP BY user_id;

-- Query 2: Daily cost trend
EXPLAIN ANALYZE
SELECT
    DATE(timestamp) AS date,
    SUM(cost_usd) AS daily_cost
FROM cost_records
WHERE user_id = 'sample-user-id'
    AND timestamp >= NOW() - INTERVAL '30 days'
GROUP BY DATE(timestamp)
ORDER BY date DESC;

-- Query 3: Top models by cost
EXPLAIN ANALYZE
SELECT
    model_name,
    SUM(cost_usd) AS total_cost,
    SUM(tokens_used) AS total_tokens
FROM cost_records
WHERE user_id = 'sample-user-id'
    AND timestamp >= NOW() - INTERVAL '30 days'
GROUP BY model_name
ORDER BY total_cost DESC
LIMIT 5;

-- ============================================================================
-- CREATE OPTIMIZED FUNCTIONS
-- ============================================================================

-- Fast user spending summary
CREATE OR REPLACE FUNCTION get_user_spending_summary(
    p_user_id UUID,
    p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
    total_cost NUMERIC,
    total_requests BIGINT,
    total_tokens BIGINT,
    providers_count INTEGER,
    models_count INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(cost_usd), 0) AS total_cost,
        COALESCE(SUM(request_count), 0) AS total_requests,
        COALESCE(SUM(tokens_used), 0) AS total_tokens,
        COUNT(DISTINCT provider_id) AS providers_count,
        COUNT(DISTINCT model_name) AS models_count
    FROM cost_records
    WHERE user_id = p_user_id
        AND timestamp >= NOW() - (p_days || ' days')::INTERVAL;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_user_spending_summary IS 'Get comprehensive spending summary for a user';

-- Fast daily cost trend
CREATE OR REPLACE FUNCTION get_daily_cost_trend(
    p_user_id UUID,
    p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
    date DATE,
    total_cost NUMERIC,
    provider_breakdown JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        DATE(timestamp) AS date,
        SUM(cost_usd) AS total_cost,
        jsonb_object_agg(
            provider_id::TEXT,
            SUM(cost_usd)
        ) AS provider_breakdown
    FROM cost_records
    WHERE user_id = p_user_id
        AND timestamp >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY DATE(timestamp)
    ORDER BY date DESC;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_daily_cost_trend IS 'Get daily cost trend with provider breakdown';

-- ============================================================================
-- CREATE INDEXES FOR COMMON FILTERS
-- ============================================================================

-- Index for recent data queries (most common)
CREATE INDEX IF NOT EXISTS cost_records_recent_user_idx
    ON cost_records (user_id, timestamp DESC)
    WHERE timestamp > NOW() - INTERVAL '90 days';

-- Index for provider-specific queries
CREATE INDEX IF NOT EXISTS cost_records_user_provider_recent_idx
    ON cost_records (user_id, provider_id, timestamp DESC)
    WHERE timestamp > NOW() - INTERVAL '90 days';

-- Index for model analytics
CREATE INDEX IF NOT EXISTS cost_records_model_cost_idx
    ON cost_records (model_name, cost_usd)
    WHERE timestamp > NOW() - INTERVAL '90 days';

-- ============================================================================
-- UPDATE TABLE STATISTICS
-- ============================================================================

-- Update statistics for query planner
ANALYZE cost_records;
ANALYZE cost_records_daily;
ANALYZE forecast_results;
ANALYZE api_credentials;
ANALYZE user_preferences;

-- ============================================================================
-- REINDEX FOR OPTIMAL PERFORMANCE
-- ============================================================================

-- Reindex tables (run during off-peak hours)
-- REINDEX TABLE CONCURRENTLY cost_records;
-- REINDEX TABLE CONCURRENTLY cost_records_daily;

-- ============================================================================
-- QUERY PERFORMANCE MONITORING
-- ============================================================================

-- Create view to monitor slow queries
CREATE OR REPLACE VIEW slow_queries AS
SELECT
    query,
    calls,
    total_time,
    mean_time,
    max_time,
    stddev_time
FROM pg_stat_statements
WHERE mean_time > 100  -- queries taking more than 100ms on average
ORDER BY mean_time DESC
LIMIT 20;

COMMENT ON VIEW slow_queries IS 'Monitor queries taking more than 100ms on average';

-- ============================================================================
-- VACUUM SETTINGS
-- ============================================================================

-- Adjust autovacuum settings for cost_records (high-write table)
ALTER TABLE cost_records SET (
    autovacuum_vacuum_scale_factor = 0.05,  -- Vacuum more frequently
    autovacuum_analyze_scale_factor = 0.025  -- Analyze more frequently
);

-- ============================================================================
-- COMPLETION MESSAGE
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '============================================================';
    RAISE NOTICE 'Query optimization complete';
    RAISE NOTICE 'Created optimized functions:';
    RAISE NOTICE '  - get_user_spending_summary(user_id, days)';
    RAISE NOTICE '  - get_daily_cost_trend(user_id, days)';
    RAISE NOTICE 'Created indexes for common query patterns';
    RAISE NOTICE 'Updated table statistics for query planner';
    RAISE NOTICE 'Created slow_queries view for monitoring';
    RAISE NOTICE '============================================================';
END $$;
