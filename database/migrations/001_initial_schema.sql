-- AI Cost Dashboard - Initial Database Schema
-- Migration: 001_initial_schema.sql
-- Description: Creates core tables for tracking AI spending across multiple providers
-- with time-series optimization, RLS policies, and comprehensive indexing.

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pgcrypto for encryption functions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- TABLES
-- ============================================================================

-- -----------------------------------------------------------------------------
-- Providers Table
-- Stores information about AI service providers
-- -----------------------------------------------------------------------------
CREATE TABLE providers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    api_base_url VARCHAR(255),
    documentation_url VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE providers IS 'AI service providers (Anthropic, OpenAI, etc.)';
COMMENT ON COLUMN providers.metadata IS 'Additional provider-specific data (e.g., supported models, rate limits)';

-- -----------------------------------------------------------------------------
-- API Credentials Table
-- Securely stores encrypted API keys and credentials
-- -----------------------------------------------------------------------------
CREATE TABLE api_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    credential_name VARCHAR(100) NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    encryption_key_id VARCHAR(50) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    last_validated_at TIMESTAMPTZ,
    validation_status VARCHAR(50), -- 'valid', 'invalid', 'pending', 'error'
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, provider_id, credential_name)
);

COMMENT ON TABLE api_credentials IS 'Encrypted API credentials for each user and provider';
COMMENT ON COLUMN api_credentials.encrypted_api_key IS 'AES-256 encrypted API key';
COMMENT ON COLUMN api_credentials.encryption_key_id IS 'Reference to encryption key version for key rotation';
COMMENT ON COLUMN api_credentials.metadata IS 'Additional credential info (e.g., organization ID, project ID)';

-- -----------------------------------------------------------------------------
-- Cost Records Table (Partitioned by month for time-series optimization)
-- Stores individual cost entries from API usage
-- -----------------------------------------------------------------------------
CREATE TABLE cost_records (
    id UUID DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ NOT NULL,
    model_name VARCHAR(100) NOT NULL,
    cost_usd NUMERIC(12, 6) NOT NULL,
    tokens_used INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    request_count INTEGER DEFAULT 1,
    collection_method VARCHAR(50) NOT NULL, -- 'api_automated', 'manual_entry', 'csv_import'
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

COMMENT ON TABLE cost_records IS 'Individual cost records from AI API usage, partitioned by month';
COMMENT ON COLUMN cost_records.collection_method IS 'How the data was collected: api_automated, manual_entry, or csv_import';
COMMENT ON COLUMN cost_records.metadata IS 'Additional usage data (e.g., endpoint, feature flags, project tags)';

-- Create partitions for current year and next year (6 months back, 18 months forward)
-- These partitions will be created automatically by the database admin or migration process

-- Partition for November 2025 - December 2025
CREATE TABLE cost_records_2025_q4 PARTITION OF cost_records
    FOR VALUES FROM ('2025-11-01') TO ('2026-01-01');

-- Partitions for 2026 (monthly partitions for better granularity)
CREATE TABLE cost_records_2026_01 PARTITION OF cost_records
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE cost_records_2026_02 PARTITION OF cost_records
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE TABLE cost_records_2026_03 PARTITION OF cost_records
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE cost_records_2026_04 PARTITION OF cost_records
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE cost_records_2026_05 PARTITION OF cost_records
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE cost_records_2026_06 PARTITION OF cost_records
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE cost_records_2026_07 PARTITION OF cost_records
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE cost_records_2026_08 PARTITION OF cost_records
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE TABLE cost_records_2026_09 PARTITION OF cost_records
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE TABLE cost_records_2026_10 PARTITION OF cost_records
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE cost_records_2026_11 PARTITION OF cost_records
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE TABLE cost_records_2026_12 PARTITION OF cost_records
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- Partitions for early 2027
CREATE TABLE cost_records_2027_q1 PARTITION OF cost_records
    FOR VALUES FROM ('2027-01-01') TO ('2027-04-01');

CREATE TABLE cost_records_2027_q2 PARTITION OF cost_records
    FOR VALUES FROM ('2027-04-01') TO ('2027-07-01');

-- -----------------------------------------------------------------------------
-- Cost Records Daily Aggregation (Materialized View)
-- Pre-aggregated daily costs for improved dashboard performance
-- -----------------------------------------------------------------------------
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

-- Create unique index for efficient refresh
CREATE UNIQUE INDEX cost_records_daily_unique_idx
    ON cost_records_daily (user_id, provider_id, date, model_name);

-- Create indexes for common query patterns
CREATE INDEX cost_records_daily_user_date_idx
    ON cost_records_daily (user_id, date DESC);

CREATE INDEX cost_records_daily_date_idx
    ON cost_records_daily (date DESC);

-- -----------------------------------------------------------------------------
-- Forecast Results Table
-- Stores ML-generated cost predictions from Prophet model
-- -----------------------------------------------------------------------------
CREATE TABLE forecast_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider_id UUID REFERENCES providers(id) ON DELETE CASCADE,
    model_name VARCHAR(100),
    forecast_date DATE NOT NULL,
    predicted_cost_usd NUMERIC(12, 6) NOT NULL,
    lower_bound_80 NUMERIC(12, 6),
    upper_bound_80 NUMERIC(12, 6),
    lower_bound_95 NUMERIC(12, 6),
    upper_bound_95 NUMERIC(12, 6),
    confidence_score NUMERIC(3, 2), -- 0.00 to 1.00
    model_version VARCHAR(50) NOT NULL,
    training_data_start DATE NOT NULL,
    training_data_end DATE NOT NULL,
    training_record_count INTEGER NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, provider_id, model_name, forecast_date, created_at)
);

COMMENT ON TABLE forecast_results IS 'ML-generated cost predictions using Prophet';
COMMENT ON COLUMN forecast_results.confidence_score IS 'Model confidence in prediction (0-1)';
COMMENT ON COLUMN forecast_results.metadata IS 'Model parameters, seasonality detection, etc.';

-- -----------------------------------------------------------------------------
-- User Preferences Table
-- Stores dashboard preferences and settings per user
-- -----------------------------------------------------------------------------
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    currency VARCHAR(10) DEFAULT 'USD',
    timezone VARCHAR(50) DEFAULT 'UTC',
    theme VARCHAR(20) DEFAULT 'system', -- 'light', 'dark', 'system'
    default_date_range VARCHAR(20) DEFAULT '30d', -- '7d', '30d', '90d', 'all'
    email_notifications BOOLEAN DEFAULT true,
    forecast_enabled BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE user_preferences IS 'User-specific dashboard settings and preferences';

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Providers indexes
CREATE INDEX providers_name_idx ON providers(name);
CREATE INDEX providers_active_idx ON providers(is_active) WHERE is_active = true;

-- API Credentials indexes
CREATE INDEX api_credentials_user_id_idx ON api_credentials(user_id);
CREATE INDEX api_credentials_provider_id_idx ON api_credentials(provider_id);
CREATE INDEX api_credentials_active_idx ON api_credentials(user_id, is_active) WHERE is_active = true;

-- Cost Records indexes (applied to all partitions)
CREATE INDEX cost_records_user_timestamp_idx ON cost_records(user_id, timestamp DESC);
CREATE INDEX cost_records_provider_timestamp_idx ON cost_records(provider_id, timestamp DESC);
CREATE INDEX cost_records_model_idx ON cost_records(model_name);
CREATE INDEX cost_records_timestamp_idx ON cost_records(timestamp DESC);
CREATE INDEX cost_records_user_provider_idx ON cost_records(user_id, provider_id, timestamp DESC);

-- Forecast Results indexes
CREATE INDEX forecast_results_user_date_idx ON forecast_results(user_id, forecast_date DESC);
CREATE INDEX forecast_results_provider_date_idx ON forecast_results(provider_id, forecast_date DESC);
CREATE INDEX forecast_results_date_idx ON forecast_results(forecast_date DESC);
CREATE INDEX forecast_results_created_idx ON forecast_results(created_at DESC);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all user-specific tables
ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- RLS Policies for API Credentials
-- -----------------------------------------------------------------------------

-- Users can only view their own credentials
CREATE POLICY "Users can view own credentials"
    ON api_credentials FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own credentials
CREATE POLICY "Users can insert own credentials"
    ON api_credentials FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own credentials
CREATE POLICY "Users can update own credentials"
    ON api_credentials FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Users can delete their own credentials
CREATE POLICY "Users can delete own credentials"
    ON api_credentials FOR DELETE
    USING (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- RLS Policies for Cost Records
-- -----------------------------------------------------------------------------

-- Users can view their own cost records
CREATE POLICY "Users can view own cost records"
    ON cost_records FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own cost records
CREATE POLICY "Users can insert own cost records"
    ON cost_records FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own cost records (for corrections)
CREATE POLICY "Users can update own cost records"
    ON cost_records FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Users can delete their own cost records
CREATE POLICY "Users can delete own cost records"
    ON cost_records FOR DELETE
    USING (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- RLS Policies for Forecast Results
-- -----------------------------------------------------------------------------

-- Users can view their own forecasts
CREATE POLICY "Users can view own forecasts"
    ON forecast_results FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own forecasts (via backend service)
CREATE POLICY "Users can insert own forecasts"
    ON forecast_results FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can delete their own forecasts
CREATE POLICY "Users can delete own forecasts"
    ON forecast_results FOR DELETE
    USING (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- RLS Policies for User Preferences
-- -----------------------------------------------------------------------------

-- Users can view their own preferences
CREATE POLICY "Users can view own preferences"
    ON user_preferences FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own preferences
CREATE POLICY "Users can insert own preferences"
    ON user_preferences FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own preferences
CREATE POLICY "Users can update own preferences"
    ON user_preferences FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- -----------------------------------------------------------------------------
-- Update timestamp trigger function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER update_providers_updated_at
    BEFORE UPDATE ON providers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_credentials_updated_at
    BEFORE UPDATE ON api_credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_preferences_updated_at
    BEFORE UPDATE ON user_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- -----------------------------------------------------------------------------
-- Automatic user preferences initialization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION initialize_user_preferences()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_preferences (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to create default preferences when user signs up
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION initialize_user_preferences();

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Insert default providers
INSERT INTO providers (name, display_name, api_base_url, documentation_url, metadata) VALUES
    ('anthropic', 'Anthropic (Claude API)', 'https://api.anthropic.com', 'https://docs.anthropic.com',
     '{"supported_models": ["claude-4-opus", "claude-4-sonnet", "claude-3.5-sonnet", "claude-3-opus", "claude-3-sonnet", "claude-3-haiku"], "collection_method": "api"}'),
    ('claude-desktop', 'Claude Desktop (Claude.ai)', NULL, 'https://claude.ai',
     '{"collection_method": "manual"}'),
    ('openai', 'OpenAI API', 'https://api.openai.com', 'https://platform.openai.com/docs',
     '{"supported_models": ["gpt-4", "gpt-4-turbo", "gpt-4o", "gpt-3.5-turbo"], "collection_method": "api"}'),
    ('chatgpt', 'ChatGPT (Manual Entry)', NULL, 'https://chat.openai.com',
     '{"collection_method": "manual"}')
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- UTILITY FUNCTIONS
-- ============================================================================

-- -----------------------------------------------------------------------------
-- Refresh materialized view function (to be called by scheduled job)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_cost_records_daily()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY cost_records_daily;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_cost_records_daily IS 'Refreshes the daily cost aggregation view (run nightly)';

-- -----------------------------------------------------------------------------
-- Get user total spend for a date range
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_user_total_spend(
    p_user_id UUID,
    p_start_date TIMESTAMPTZ,
    p_end_date TIMESTAMPTZ
)
RETURNS NUMERIC AS $$
DECLARE
    total_spend NUMERIC;
BEGIN
    SELECT COALESCE(SUM(cost_usd), 0)
    INTO total_spend
    FROM cost_records
    WHERE user_id = p_user_id
        AND timestamp >= p_start_date
        AND timestamp < p_end_date;

    RETURN total_spend;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION get_user_total_spend IS 'Calculate total spend for a user in a date range';

-- -----------------------------------------------------------------------------
-- Get top models by spend for a user
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_top_models_by_spend(
    p_user_id UUID,
    p_start_date TIMESTAMPTZ,
    p_end_date TIMESTAMPTZ,
    p_limit INTEGER DEFAULT 5
)
RETURNS TABLE (
    model_name VARCHAR(100),
    total_cost NUMERIC,
    total_tokens BIGINT,
    request_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cr.model_name,
        SUM(cr.cost_usd) AS total_cost,
        SUM(cr.tokens_used) AS total_tokens,
        SUM(cr.request_count) AS request_count
    FROM cost_records cr
    WHERE cr.user_id = p_user_id
        AND cr.timestamp >= p_start_date
        AND cr.timestamp < p_end_date
    GROUP BY cr.model_name
    ORDER BY total_cost DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION get_top_models_by_spend IS 'Get top N models by spending for a user in date range';

-- ============================================================================
-- PARTITION MANAGEMENT
-- ============================================================================

-- -----------------------------------------------------------------------------
-- Function to create new monthly partition
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_monthly_partition(
    p_year INTEGER,
    p_month INTEGER
)
RETURNS void AS $$
DECLARE
    partition_name TEXT;
    start_date TEXT;
    end_date TEXT;
BEGIN
    -- Generate partition name and date ranges
    partition_name := format('cost_records_%s_%s', p_year, LPAD(p_month::TEXT, 2, '0'));
    start_date := format('%s-%s-01', p_year, LPAD(p_month::TEXT, 2, '0'));

    -- Calculate end date (first day of next month)
    IF p_month = 12 THEN
        end_date := format('%s-01-01', p_year + 1);
    ELSE
        end_date := format('%s-%s-01', p_year, LPAD((p_month + 1)::TEXT, 2, '0'));
    END IF;

    -- Create partition
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF cost_records FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        start_date,
        end_date
    );

    RAISE NOTICE 'Created partition % for date range % to %', partition_name, start_date, end_date;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_monthly_partition IS 'Creates a new monthly partition for cost_records table';

-- ============================================================================
-- GRANTS
-- ============================================================================

-- Grant necessary permissions to authenticated users
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

-- Log migration completion
DO $$
BEGIN
    RAISE NOTICE '==============================================================';
    RAISE NOTICE 'Migration 001_initial_schema.sql completed successfully';
    RAISE NOTICE 'Created tables: providers, api_credentials, cost_records,';
    RAISE NOTICE '                forecast_results, user_preferences';
    RAISE NOTICE 'Created materialized view: cost_records_daily';
    RAISE NOTICE 'Enabled RLS on all user-specific tables';
    RAISE NOTICE 'Created 15 partitions for cost_records (2025 Q4 - 2027 Q2)';
    RAISE NOTICE 'Seeded 4 default providers';
    RAISE NOTICE '==============================================================';
END $$;
