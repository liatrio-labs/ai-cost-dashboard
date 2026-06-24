-- ============================================================================
-- Migration 002: Add automated-collection providers
-- ----------------------------------------------------------------------------
-- Adds the providers unlocked by the automation build-out:
--   * claude-ai : Claude Enterprise Analytics API (claude.ai usage surface,
--                 distinct from the developer Admin API provider 'anthropic')
--   * cursor    : Cursor Admin API (Business/Team per-member spend)
--   * vercel    : Vercel REST usage/billing API (Team)
--
-- ChatGPT (admin.openai.com) remains the existing 'chatgpt' manual/CSV provider.
-- Idempotent: safe to re-run.
-- ============================================================================

INSERT INTO providers (name, display_name, api_base_url, documentation_url, metadata) VALUES
    ('claude-ai', 'Claude.ai (Enterprise Analytics)',
     'https://api.anthropic.com/v1/organizations/analytics',
     'https://support.claude.com/en/articles/13703965-claude-enterprise-analytics-api-reference-guide',
     '{"collection_method": "api", "scope": "read:analytics", "plan": "enterprise"}'),
    ('cursor', 'Cursor (Admin API)',
     'https://api.cursor.com',
     'https://cursor.com/docs/account/teams/admin-api',
     '{"collection_method": "api", "auth": "basic", "tier": "business"}'),
    ('vercel', 'Vercel (Usage API)',
     'https://api.vercel.com',
     'https://vercel.com/docs/rest-api',
     '{"collection_method": "api", "auth": "bearer", "tier": "team"}')
ON CONFLICT (name) DO NOTHING;
