-- ============================================================================
-- Migration 011: Project -> team mapping (issue #7, epic #4)
-- ----------------------------------------------------------------------------
-- The admin Unassigned queue groups unassigned spend by person email, API key
-- and project, each with a one-click assign. People and keys already have a
-- team column (010); projects had nowhere to be assigned. This adds:
--
--   org_projects -> provider project id (OpenAI project, Vercel project)
--                   -> team. Metadata only.
--
-- and recreates cost_records_daily_attributed so a project's team is the last
-- team fallback. Attribution precedence (mirrored by
-- frontend/lib/org/attribution.ts):
--
--   1. Person: unchanged from 010.
--   2. Team: the API key's team_id; else the resolved person's team_id;
--      else the project's team_id (provider + attribution.project_id);
--      else none (Unassigned).
--   3. Department: the team's department_id; else none (Unassigned).
--
-- The join hits UNIQUE (provider_id, external_project_id), so rows cannot fan
-- out and attributed + Unassigned still equals the org total.
--
-- Access matches 010: authenticated SELECT, service_role writes, RLS on.
-- Idempotent: safe to re-run, and safe to re-run after re-applying 010.
-- ============================================================================

CREATE TABLE IF NOT EXISTS org_projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    external_project_id VARCHAR(255) NOT NULL CHECK (external_project_id <> ''),
    name VARCHAR(200),
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT org_projects_provider_external_key UNIQUE (provider_id, external_project_id)
);

CREATE INDEX IF NOT EXISTS org_projects_team_id_idx ON org_projects (team_id);

COMMENT ON TABLE org_projects IS 'Provider project metadata (OpenAI / Vercel project) with the team that owns its spend';

DROP TRIGGER IF EXISTS update_org_projects_updated_at ON org_projects;
CREATE TRIGGER update_org_projects_updated_at
    BEFORE UPDATE ON org_projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE org_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can view org projects" ON org_projects;
CREATE POLICY "Authenticated can view org projects"
    ON org_projects FOR SELECT TO authenticated USING (true);

REVOKE ALL ON org_projects FROM anon;
GRANT SELECT ON org_projects TO authenticated;
GRANT ALL ON org_projects TO service_role;

-- ----------------------------------------------------------------------------
-- cost_records_daily_attributed: same columns, grain and indexes as 010; the
-- only change is the project team fallback.
-- ----------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS cost_records_daily_attributed;

CREATE MATERIALIZED VIEW cost_records_daily_attributed AS
WITH src AS (
    SELECT
        cr.provider_id,
        DATE(cr.timestamp) AS date,
        cr.model_name,
        cr.cost_usd,
        cr.tokens_used,
        cr.input_tokens,
        cr.output_tokens,
        cr.request_count,
        NULLIF(lower(btrim(cr.metadata -> 'attribution' ->> 'person_email')), '') AS a_person_email,
        NULLIF(cr.metadata -> 'attribution' ->> 'person_external_id', '') AS a_person_external_id,
        NULLIF(cr.metadata -> 'attribution' ->> 'api_key_id', '') AS a_api_key_id,
        NULLIF(cr.metadata -> 'attribution' ->> 'project_id', '') AS a_project_id,
        NULLIF(cr.metadata -> 'attribution' ->> 'workspace_id', '') AS a_workspace_id,
        CASE
            WHEN cr.metadata -> 'attribution' ->> 'granularity'
                 IN ('person', 'api_key', 'project', 'workspace', 'org')
            THEN cr.metadata -> 'attribution' ->> 'granularity'
            ELSE 'org'
        END AS granularity
    FROM cost_records cr
),
resolved AS (
    -- Every join below hits a unique key, so no row can fan out and totals
    -- are preserved.
    SELECT
        s.*,
        k.id AS org_api_key_id,
        k.team_id AS key_team_id,
        op.team_id AS project_team_id,
        COALESCE(pe.id, pix.person_id, pim.person_id, k.owner_person_id) AS person_id
    FROM src s
    LEFT JOIN people pe
        ON pe.email = s.a_person_email
    LEFT JOIN person_identities pix
        ON pix.provider_id = s.provider_id AND pix.external_id = s.a_person_external_id
    LEFT JOIN person_identities pim
        ON pim.provider_id = s.provider_id AND pim.external_id = s.a_person_email
    LEFT JOIN org_api_keys k
        ON k.provider_id = s.provider_id AND k.external_key_id = s.a_api_key_id
    LEFT JOIN org_projects op
        ON op.provider_id = s.provider_id AND op.external_project_id = s.a_project_id
),
teamed AS (
    SELECT
        r.*,
        COALESCE(r.key_team_id, p.team_id, r.project_team_id) AS team_id
    FROM resolved r
    LEFT JOIN people p ON p.id = r.person_id
)
SELECT
    t.date,
    t.provider_id,
    t.model_name,
    t.person_id,
    t.org_api_key_id,
    t.team_id,
    tm.department_id,
    t.a_project_id AS project_id,
    t.a_workspace_id AS workspace_id,
    t.granularity,
    SUM(t.cost_usd) AS total_cost_usd,
    SUM(t.tokens_used) AS total_tokens,
    SUM(t.input_tokens) AS total_input_tokens,
    SUM(t.output_tokens) AS total_output_tokens,
    SUM(t.request_count) AS total_requests,
    COUNT(*) AS record_count
FROM teamed t
LEFT JOIN teams tm ON tm.id = t.team_id
GROUP BY
    t.date, t.provider_id, t.model_name, t.person_id, t.org_api_key_id,
    t.team_id, tm.department_id, t.a_project_id, t.a_workspace_id, t.granularity;

COMMENT ON MATERIALIZED VIEW cost_records_daily_attributed IS
    'Daily costs resolved to person / API key / team / department (NULL = Unassigned). Current-state membership. Team: key, else person, else project.';

CREATE UNIQUE INDEX cost_records_daily_attributed_unique_idx
    ON cost_records_daily_attributed (
        date, provider_id, model_name, person_id, org_api_key_id,
        team_id, department_id, project_id, workspace_id, granularity
    ) NULLS NOT DISTINCT;

CREATE INDEX cost_records_daily_attributed_date_idx
    ON cost_records_daily_attributed (date DESC);
CREATE INDEX cost_records_daily_attributed_department_date_idx
    ON cost_records_daily_attributed (department_id, date DESC);
CREATE INDEX cost_records_daily_attributed_team_date_idx
    ON cost_records_daily_attributed (team_id, date DESC);
CREATE INDEX cost_records_daily_attributed_person_date_idx
    ON cost_records_daily_attributed (person_id, date DESC);
CREATE INDEX cost_records_daily_attributed_key_date_idx
    ON cost_records_daily_attributed (org_api_key_id, date DESC);

REVOKE ALL ON cost_records_daily_attributed FROM anon;
GRANT SELECT ON cost_records_daily_attributed TO authenticated, service_role;

-- refresh_cost_records_daily() from 010 already refreshes this view by name.
