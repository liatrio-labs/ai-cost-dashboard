-- ============================================================================
-- Migration 006: Add Vercel AI Gateway provider
-- ----------------------------------------------------------------------------
-- AI Gateway is billed via AI Gateway Credits — a separate path from the FOCUS
-- billing charges the 'vercel' provider collects — so it needs its own provider
-- and collector. Cost comes from the Custom Reporting API
-- (GET https://ai-gateway.vercel.sh/v1/report, group_by=day), using `total_cost`
-- (what you're charged; $0 for BYOK to avoid double-counting). Requires a
-- dedicated AI_GATEWAY_API_KEY (Pro/Enterprise).
--
-- Idempotent: safe to re-run.
-- ============================================================================

INSERT INTO providers (name, display_name, api_base_url, documentation_url, metadata) VALUES
    ('vercel-ai-gateway', 'Vercel AI Gateway',
     'https://ai-gateway.vercel.sh',
     'https://vercel.com/docs/ai-gateway/observability-and-spend/custom-reporting',
     '{"collection_method": "api", "auth": "bearer", "cost_basis": "actual_usd", "billing": "credits"}')
ON CONFLICT (name) DO NOTHING;
