-- ============================================================================
-- Migration 005: Add Apify and Windsurf providers
-- ----------------------------------------------------------------------------
--   * apify    : Apify REST API — GET /v2/users/me/usage/monthly returns real
--                USD spend with a per-day, per-service breakdown.
--   * windsurf : Windsurf (Codeium) v1 CascadeAnalytics. The team is on QUOTA
--                billing, which the v2 consumption (credit/ACU) endpoint does
--                not support, and v1 exposes usage only (messagesSent per model
--                per day) — no cost field. Spend is EXTRAPOLATED from messages
--                using a configurable credit rate (WINDSURF_USD_PER_CREDIT,
--                WINDSURF_CREDITS_PER_MESSAGE). The $40/seat base subscription
--                is not part of this API and is tracked separately.
--
-- Idempotent: safe to re-run.
-- ============================================================================

INSERT INTO providers (name, display_name, api_base_url, documentation_url, metadata) VALUES
    ('apify', 'Apify (Usage API)',
     'https://api.apify.com',
     'https://docs.apify.com/api/v2/users-me-usage-monthly-get',
     '{"collection_method": "api", "auth": "bearer", "cost_basis": "actual_usd"}'),
    ('windsurf', 'Windsurf (CascadeAnalytics)',
     'https://server.codeium.com',
     'https://docs.devin.ai/desktop/accounts/api-reference/analytics-api-introduction',
     '{"collection_method": "api", "auth": "service_key", "billing": "quota", "cost_basis": "extrapolated_from_messages"}')
ON CONFLICT (name) DO NOTHING;
