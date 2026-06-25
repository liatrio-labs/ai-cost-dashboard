-- ============================================================================
-- Migration 007: app_settings (admin-editable app configuration)
-- ----------------------------------------------------------------------------
-- Simple key/value store for settings the admin can edit at runtime. First use:
-- the forecast model, which scales the plateau by total employee count
-- (baseline 160 employees -> ~$58k/mo, +/- per_person_pct per head).
--
-- Idempotent: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES
  ('forecast', '{"employees": 160, "baseline_employees": 160, "baseline_plateau_usd": 58000, "per_person_pct": 0.02}')
ON CONFLICT (key) DO NOTHING;
