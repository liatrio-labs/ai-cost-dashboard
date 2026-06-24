-- ============================================================================
-- Migration 003: Shared org-wide read access
-- ----------------------------------------------------------------------------
-- The dashboard is a shared internal view: provider data is collected with
-- org-level API keys (environment secrets) and attributed to a single owner
-- user. Every authenticated user should see the same data.
--
-- This relaxes the per-user SELECT policies on cost_records and forecast_results
-- so any authenticated user can read all rows. INSERT/UPDATE/DELETE remain
-- owner/service-scoped (automated collection writes with the service role and
-- bypasses RLS; manual CSV import still writes under the importing user).
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- cost_records: shared read
DROP POLICY IF EXISTS "Users can view own cost records" ON cost_records;
DROP POLICY IF EXISTS "Authenticated can view all cost records" ON cost_records;
CREATE POLICY "Authenticated can view all cost records"
    ON cost_records FOR SELECT
    TO authenticated
    USING (true);

-- forecast_results: shared read
DROP POLICY IF EXISTS "Users can view own forecasts" ON forecast_results;
DROP POLICY IF EXISTS "Authenticated can view all forecasts" ON forecast_results;
CREATE POLICY "Authenticated can view all forecasts"
    ON forecast_results FOR SELECT
    TO authenticated
    USING (true);

-- The daily rollup is a materialized view (not covered by RLS); ensure the
-- authenticated role can read it.
GRANT SELECT ON cost_records_daily TO authenticated;
