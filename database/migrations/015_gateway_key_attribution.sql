-- ============================================================================
-- Migration 015: AI Gateway key -> person / project attribution (issue #24)
-- ----------------------------------------------------------------------------
-- Vercel AI Gateway keys carry who created them (createdBy), whether their
-- spend belongs to that user or the team (metadata.spendAttribution) and,
-- for project-scoped keys, a projectId. The gateway key sync
-- (frontend/lib/org/gateway-sync.ts) writes those onto org_api_keys and
-- auto-assigns an owner (spendAttribution = user) and a project (scoped keys).
-- This adds:
--
--   org_api_keys.org_project_id            -> org_projects (ON DELETE SET NULL)
--   org_api_keys.external_created_by       provider user id that created the key
--   org_api_keys.external_created_by_email that user's email, when known
--   org_api_keys.spend_attribution         'user' | 'team' | NULL (unset = team)
--   org_api_keys.assignment_source         'auto' | 'manual' | NULL
--
-- assignment_source: 'auto' means owner/project were set by the key sync and
-- the next sync may update them; 'manual' means an admin set the owner, team
-- or project by hand and the sync never touches those three columns again.
-- NULL means nothing has been assigned. Keys registered by hand before 015
-- (owner or team already set) are marked 'manual' below.
--
-- cost_records_daily_attributed is recreated so a key's assigned project
-- counts. Attribution precedence (mirrored by frontend/lib/org/attribution.ts):
--
--   1. Person: unchanged from 010 (people.email, identities, key owner).
--   2. Project: the row's attribution.project_id (provider + external id in
--      org_projects); else, only when the row has no project_id, the key's
--      org_project_id (same provider only).
--   3. Team: the API key's team_id; else the resolved person's team_id;
--      else the project's team_id; else none (Unassigned).
--   4. Department: the team's department_id; else none (Unassigned).
--
-- The view's project_id column is now the effective project external id
-- (the row's, else the key's project), so a key-assigned project shows in the
-- dashboard's project drill-down. With no key projects assigned (every
-- install before the sync runs) the view is identical to 011's.
--
-- Every join hits a unique key (people.email, person_identities (provider,
-- external_id), org_api_keys (provider, external_key_id), org_projects
-- (provider, external_project_id) and org_projects.id), so rows cannot fan
-- out and attributed + Unassigned still equals the org total.
--
-- Access matches 010/011/014: authenticated SELECT, service_role writes,
-- RLS on, no anon/PUBLIC on the rollup.
-- Re-running 010 or 011 recreates the view without the key project, so
-- re-apply 014 and then this migration after them.
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- org_api_keys columns
-- ----------------------------------------------------------------------------
ALTER TABLE org_api_keys
    ADD COLUMN IF NOT EXISTS org_project_id UUID REFERENCES org_projects(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS external_created_by VARCHAR(255),
    ADD COLUMN IF NOT EXISTS external_created_by_email VARCHAR(320),
    ADD COLUMN IF NOT EXISTS spend_attribution VARCHAR(20),
    ADD COLUMN IF NOT EXISTS assignment_source VARCHAR(10);

ALTER TABLE org_api_keys DROP CONSTRAINT IF EXISTS org_api_keys_spend_attribution_check;
ALTER TABLE org_api_keys ADD CONSTRAINT org_api_keys_spend_attribution_check
    CHECK (spend_attribution IS NULL OR spend_attribution IN ('user', 'team'));

ALTER TABLE org_api_keys DROP CONSTRAINT IF EXISTS org_api_keys_assignment_source_check;
ALTER TABLE org_api_keys ADD CONSTRAINT org_api_keys_assignment_source_check
    CHECK (assignment_source IS NULL OR assignment_source IN ('auto', 'manual'));

CREATE INDEX IF NOT EXISTS org_api_keys_org_project_id_idx ON org_api_keys (org_project_id);

-- Keys an admin assigned before 015 were set by hand.
UPDATE org_api_keys
SET assignment_source = 'manual'
WHERE assignment_source IS NULL
  AND (owner_person_id IS NOT NULL OR team_id IS NOT NULL OR org_project_id IS NOT NULL);

COMMENT ON COLUMN org_api_keys.org_project_id IS
    'Project this key''s spend belongs to (Vercel project-scoped keys, or set by an admin)';
COMMENT ON COLUMN org_api_keys.external_created_by IS 'Provider user id that created the key (Vercel createdBy)';
COMMENT ON COLUMN org_api_keys.external_created_by_email IS 'Email of external_created_by, when the provider exposes it';
COMMENT ON COLUMN org_api_keys.spend_attribution IS
    'Provider spend attribution setting: user (creator) or team. NULL = unset, treated as team';
COMMENT ON COLUMN org_api_keys.assignment_source IS
    'auto = owner/project set by the key sync (may be updated); manual = set by an admin (never overwritten by the sync)';

-- ----------------------------------------------------------------------------
-- cost_records_daily_attributed: same grain, columns and indexes as 011; the
-- project now falls back to the key's org_project_id.
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
        -- The row's project wins; the key's project applies only when the row
        -- names none.
        CASE WHEN s.a_project_id IS NOT NULL THEN op.team_id ELSE kp.team_id END AS project_team_id,
        COALESCE(s.a_project_id, kp.external_project_id) AS eff_project_id,
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
    LEFT JOIN org_projects kp
        ON kp.id = k.org_project_id AND kp.provider_id = s.provider_id
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
    t.eff_project_id AS project_id,
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
    t.team_id, tm.department_id, t.eff_project_id, t.a_workspace_id, t.granularity;

COMMENT ON MATERIALIZED VIEW cost_records_daily_attributed IS
    'Daily costs resolved to person / API key / project / team / department (NULL = Unassigned). Current-state membership. Team: key, else person, else project (row project, else key project).';

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

-- Materialized views are not covered by RLS. Same grants as 014 section 7.
REVOKE ALL ON public.cost_records_daily_attributed FROM PUBLIC, anon;
GRANT SELECT ON public.cost_records_daily_attributed TO authenticated, service_role;

-- refresh_cost_records_daily() (010, hardened in 014) already refreshes this
-- view by name; org_api_keys keeps 010's RLS policy and grants (ALTER TABLE
-- ADD COLUMN does not change them).
