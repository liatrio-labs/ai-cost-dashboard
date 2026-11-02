-- ============================================================================
-- Migration 010: Org structure and attributed daily rollup
-- ----------------------------------------------------------------------------
-- Adds the org model used to break spend down below the org level (epic #4):
--
--   departments        -> top-level grouping
--   teams              -> optionally belong to a department
--   people             -> NOT auth.users; most people never sign in
--   person_identities  -> provider user/actor id (or email) -> person
--   org_api_keys       -> provider key METADATA (never secrets) -> owner/team.
--                         Separate from the legacy api_credentials table.
--
-- and the materialized view cost_records_daily_attributed, which resolves
-- cost_records.metadata.attribution (the shared contract from #4) to a person,
-- API key, team and department per day.
--
-- Attribution precedence (mirrored exactly by frontend/lib/org/attribution.ts):
--   1. Person: attribution.person_email = people.email (case-insensitive);
--      else (provider, person_external_id) in person_identities;
--      else (provider, person_email) in person_identities.external_id;
--      else the API key's owner_person_id; else none.
--   2. Team: the API key's team_id; else the resolved person's team_id;
--      else none (Unassigned).
--   3. Department: the team's department_id; else none (Unassigned).
--   Empty strings count as absent. Emails are trimmed and lower-cased before
--   matching; external ids and key ids match exactly.
--
-- DECISION: membership is current-state only. The view joins the CURRENT
-- people/teams/keys, so reassigning a person (or key, or team) moves their
-- historical spend with them on the next refresh. There is no effective-dated
-- membership history.
--
-- Rows with no attribution (every row written before #6) resolve to nothing
-- and land in the Unassigned bucket with granularity 'org', so attributed
-- spend plus Unassigned always equals the org total in cost_records_daily.
--
-- refresh_cost_records_daily() now refreshes both views, so the existing
-- 15-minute cron keeps working unchanged.
--
-- Access: authenticated users can read; writes go through the service role
-- (admin routes), matching migration 003.
--
-- Requires PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT).
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- departments
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- teams (name unique within a department; NULLS NOT DISTINCT also keeps
-- department-less team names unique)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT teams_department_name_key UNIQUE NULLS NOT DISTINCT (department_id, name)
);

CREATE INDEX IF NOT EXISTS teams_department_id_idx ON teams (department_id);

-- ----------------------------------------------------------------------------
-- people
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(320) NOT NULL UNIQUE,
    display_name VARCHAR(200),
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT people_email_lowercase CHECK (email = lower(btrim(email)) AND email <> '')
);

CREATE INDEX IF NOT EXISTS people_team_id_idx ON people (team_id);

-- ----------------------------------------------------------------------------
-- person_identities: provider user/actor id or email -> person
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_identities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    external_id VARCHAR(320) NOT NULL CHECK (external_id <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT person_identities_provider_external_key UNIQUE (provider_id, external_id)
);

CREATE INDEX IF NOT EXISTS person_identities_person_id_idx ON person_identities (person_id);

-- ----------------------------------------------------------------------------
-- org_api_keys: key metadata only, never secrets
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    external_key_id VARCHAR(255) NOT NULL CHECK (external_key_id <> ''),
    name VARCHAR(200),
    owner_person_id UUID REFERENCES people(id) ON DELETE SET NULL,
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT org_api_keys_provider_external_key UNIQUE (provider_id, external_key_id)
);

CREATE INDEX IF NOT EXISTS org_api_keys_owner_person_id_idx ON org_api_keys (owner_person_id);
CREATE INDEX IF NOT EXISTS org_api_keys_team_id_idx ON org_api_keys (team_id);

COMMENT ON TABLE departments IS 'Org departments; teams roll up into these';
COMMENT ON TABLE teams IS 'Org teams, optionally inside a department';
COMMENT ON TABLE people IS 'People whose AI spend is attributed (not auth.users; most never sign in)';
COMMENT ON TABLE person_identities IS 'Maps a provider user/actor id or email to a person';
COMMENT ON TABLE org_api_keys IS 'Provider API key metadata (never secrets) with owner and team';

-- ----------------------------------------------------------------------------
-- updated_at triggers (update_updated_at_column() is from 001)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS update_departments_updated_at ON departments;
CREATE TRIGGER update_departments_updated_at
    BEFORE UPDATE ON departments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_teams_updated_at ON teams;
CREATE TRIGGER update_teams_updated_at
    BEFORE UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_people_updated_at ON people;
CREATE TRIGGER update_people_updated_at
    BEFORE UPDATE ON people
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_person_identities_updated_at ON person_identities;
CREATE TRIGGER update_person_identities_updated_at
    BEFORE UPDATE ON person_identities
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_org_api_keys_updated_at ON org_api_keys;
CREATE TRIGGER update_org_api_keys_updated_at
    BEFORE UPDATE ON org_api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ----------------------------------------------------------------------------
-- RLS + grants: authenticated read, service role writes (bypasses RLS)
-- ----------------------------------------------------------------------------
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can view departments" ON departments;
CREATE POLICY "Authenticated can view departments"
    ON departments FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated can view teams" ON teams;
CREATE POLICY "Authenticated can view teams"
    ON teams FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated can view people" ON people;
CREATE POLICY "Authenticated can view people"
    ON people FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated can view person identities" ON person_identities;
CREATE POLICY "Authenticated can view person identities"
    ON person_identities FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated can view org api keys" ON org_api_keys;
CREATE POLICY "Authenticated can view org api keys"
    ON org_api_keys FOR SELECT TO authenticated USING (true);

REVOKE ALL ON departments, teams, people, person_identities, org_api_keys FROM anon;
GRANT SELECT ON departments, teams, people, person_identities, org_api_keys TO authenticated;
GRANT ALL ON departments, teams, people, person_identities, org_api_keys TO service_role;

-- ----------------------------------------------------------------------------
-- cost_records_daily_attributed
-- Same grain as cost_records_daily plus the attribution dimensions. user_id is
-- deliberately not a key: collection attributes every row to one owner user.
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
),
teamed AS (
    SELECT
        r.*,
        COALESCE(r.key_team_id, p.team_id) AS team_id
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
    'Daily costs resolved to person / API key / team / department (NULL = Unassigned). Current-state membership.';

-- NULLS NOT DISTINCT: the attribution keys are nullable (NULL = Unassigned)
-- and REFRESH ... CONCURRENTLY needs a unique index covering every row.
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

-- Materialized views are not covered by RLS.
REVOKE ALL ON cost_records_daily_attributed FROM anon;
GRANT SELECT ON cost_records_daily_attributed TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Refresh both rollups from the existing cron entry point.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_cost_records_daily()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY cost_records_daily;
    REFRESH MATERIALIZED VIEW CONCURRENTLY cost_records_daily_attributed;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_cost_records_daily IS
    'Refreshes cost_records_daily and cost_records_daily_attributed (called by the refresh-aggregates cron)';
