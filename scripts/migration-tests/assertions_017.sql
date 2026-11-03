-- Assertions for 017 (issue #32): Anthropic key sync columns, and the
-- attribution precedence the key sync relies on, checked against the real
-- cost_records_daily_attributed view (which 017 does not change).
-- Runs after assertions.sql, _015 and _016, with 017 applied twice over the
-- fixtures. Adds its own Anthropic fixtures and removes them at the end.
-- Any failure raises (ON_ERROR_STOP).
--
-- Anthropic projects (workspaces as projects): wrk_res -> Data, default (no team)
-- Anthropic keys (as the key sync writes them):
--   an_alice   auto owner alice (creator), project wrk_res
--   an_svc     no owner (service account), project wrk_res
--   an_manual  manual owner carol (no team), project wrk_res
--   an_def     auto owner bob (Field), project default
--
-- By the time this runs, assertions.sql has moved alice to Data.

CREATE FUNCTION pg_temp.check(label TEXT, ok BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL: %', label;
    END IF;
    RAISE NOTICE 'PASS: %', label;
END $$;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('017: org_api_keys has external_status and unresolved_reason',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'org_api_keys'
        AND column_name IN ('external_status', 'unresolved_reason')) = 2);
SELECT pg_temp.check('017: existing keys keep NULL status and reason',
    (SELECT count(*) FROM org_api_keys WHERE external_status IS NOT NULL OR unresolved_reason IS NOT NULL) = 0);
DO $$
BEGIN
    UPDATE org_api_keys SET unresolved_reason = 'because' WHERE external_key_id = 'key_bare';
    RAISE EXCEPTION 'FAIL: bad unresolved_reason accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 017: unresolved_reason must be a known reason or NULL';
END $$;

CREATE TEMP TABLE before_snapshot AS
SELECT count(*) AS n, sum(cost_usd) AS s FROM cost_records;

-- ---------------------------------------------------------------------------
-- Anthropic fixtures
-- ---------------------------------------------------------------------------
INSERT INTO org_projects (provider_id, external_project_id, name, team_id)
SELECT p.id, v.ext, v.name, t.id
FROM (VALUES ('wrk_res', 'Research', 'Data'), ('default', 'Default', NULL)) AS v(ext, name, team)
JOIN providers p ON p.name = 'anthropic'
LEFT JOIN teams t ON t.name = v.team;

INSERT INTO org_api_keys (provider_id, external_key_id, name, owner_person_id, team_id, org_project_id,
                          external_created_by, external_created_by_email, assignment_source,
                          external_status, unresolved_reason)
SELECT p.id, v.ext, v.ext, pe.id, NULL, op.id, v.created_by, v.owner, v.source, v.status, v.reason
FROM (VALUES
        ('an_alice',  'alice@liatrio.com', 'wrk_res', 'user_alice',           'auto',   'active',   NULL),
        ('an_svc',    NULL,                'wrk_res', 'service_account:sa_1', 'auto',   'archived', 'service_account'),
        ('an_manual', 'carol@liatrio.com', 'wrk_res', 'user_alice',           'manual', 'active',   NULL),
        ('an_def',    'bob@liatrio.com',   'default', 'user_bob',             'auto',   'inactive', NULL)
     ) AS v(ext, owner, project, created_by, source, status, reason)
JOIN providers p ON p.name = 'anthropic'
LEFT JOIN people pe ON pe.email = v.owner
JOIN org_projects op ON op.provider_id = p.id AND op.external_project_id = v.project;

-- Rows as the Anthropic collector writes them: project_id = workspace_id
-- (none for the default workspace).
CREATE TEMP TABLE afx (model TEXT, cost NUMERIC, meta JSONB);
INSERT INTO afx VALUES
    ('a_actor',   1.00, '{"attribution":{"api_key_id":"an_alice","workspace_id":"wrk_res","project_id":"wrk_res","person_email":"bob@liatrio.com","person_external_id":"user_bob","granularity":"person"}}'),
    ('a_owner',   2.00, '{"attribution":{"api_key_id":"an_alice","workspace_id":"wrk_res","project_id":"wrk_res","granularity":"api_key"}}'),
    ('a_svc',     4.00, '{"attribution":{"api_key_id":"an_svc","workspace_id":"wrk_res","project_id":"wrk_res","granularity":"api_key"}}'),
    ('a_manual',  8.00, '{"attribution":{"api_key_id":"an_manual","workspace_id":"wrk_res","project_id":"wrk_res","granularity":"api_key"}}'),
    ('a_def',    16.00, '{"attribution":{"api_key_id":"an_def","granularity":"api_key"}}'),
    ('a_ws',     32.00, '{"attribution":{"workspace_id":"wrk_res","project_id":"wrk_res","granularity":"workspace"}}'),
    ('a_unknown',64.00, '{"attribution":{"workspace_id":"wrk_x","project_id":"wrk_x","granularity":"workspace"}}');

INSERT INTO cost_records (user_id, provider_id, timestamp, model_name, cost_usd,
                          tokens_used, input_tokens, output_tokens, request_count,
                          collection_method, metadata)
SELECT '00000000-0000-0000-0000-000000000001', p.id, '2026-11-04 00:00+00', afx.model, afx.cost,
       10, 6, 4, 1, 'api_automated', afx.meta
FROM afx JOIN providers p ON p.name = 'anthropic';

SELECT refresh_cost_records_daily();

CREATE TEMP VIEW aatt AS
SELECT
    a.model_name AS model,
    pe.email AS person,
    k.external_key_id AS api_key,
    t.name AS team,
    a.project_id,
    a.total_cost_usd
FROM cost_records_daily_attributed a
JOIN providers pr ON pr.id = a.provider_id AND pr.name = 'anthropic'
LEFT JOIN people pe ON pe.id = a.person_id
LEFT JOIN org_api_keys k ON k.id = a.org_api_key_id
LEFT JOIN teams t ON t.id = a.team_id
WHERE a.date = '2026-11-04';

-- ---------------------------------------------------------------------------
-- Precedence (issue #32)
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('017: 1. a user_actor row on a key owned by someone else resolves to the actor',
    EXISTS (SELECT 1 FROM aatt WHERE model = 'a_actor'
            AND api_key = 'an_alice' AND person = 'bob@liatrio.com' AND team = 'Field' AND project_id = 'wrk_res'));
SELECT pg_temp.check('017: 2. a manual owner wins (owner without a team keeps the workspace project team)',
    EXISTS (SELECT 1 FROM aatt WHERE model = 'a_manual'
            AND person = 'carol@liatrio.com' AND team = 'Data'));
SELECT pg_temp.check('017: 3. the automatic creator owner and their team',
    EXISTS (SELECT 1 FROM aatt WHERE model = 'a_owner'
            AND person = 'alice@liatrio.com' AND team = 'Data' AND project_id = 'wrk_res'));
SELECT pg_temp.check('017: 4. no owner -> the workspace project''s team',
    EXISTS (SELECT 1 FROM aatt WHERE model = 'a_svc' AND person IS NULL AND team = 'Data')
    AND EXISTS (SELECT 1 FROM aatt WHERE model = 'a_ws' AND person IS NULL AND api_key IS NULL AND team = 'Data'));
SELECT pg_temp.check('017: default-workspace rows get the key''s Default project',
    EXISTS (SELECT 1 FROM aatt WHERE model = 'a_def'
            AND person = 'bob@liatrio.com' AND team = 'Field' AND project_id = 'default'));
SELECT pg_temp.check('017: 5. an unmapped workspace with no key is Unassigned',
    EXISTS (SELECT 1 FROM aatt WHERE model = 'a_unknown' AND person IS NULL AND team IS NULL));
SELECT pg_temp.check('017: one view row per Anthropic fixture (no fan-out)',
    (SELECT count(*) FROM aatt) = 7 AND (SELECT sum(total_cost_usd) FROM aatt) = 127);

-- ---------------------------------------------------------------------------
-- Totals still reconcile
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('017: for every date, attributed totals equal cost_records_daily totals',
    (SELECT count(*) FROM (
        SELECT date, sum(total_cost_usd) c, sum(total_tokens) tk, sum(record_count) n
        FROM cost_records_daily_attributed GROUP BY date
    ) a FULL JOIN (
        SELECT date, sum(total_cost_usd) c, sum(total_tokens) tk, sum(record_count) n
        FROM cost_records_daily GROUP BY date
    ) d USING (date)
    WHERE a.c IS DISTINCT FROM d.c OR a.tk IS DISTINCT FROM d.tk OR a.n IS DISTINCT FROM d.n) = 0);
SELECT pg_temp.check('017: attributed + Unassigned equals the org total',
    (SELECT sum(total_cost_usd) FROM cost_records_daily_attributed WHERE team_id IS NOT NULL)
    + (SELECT sum(total_cost_usd) FROM cost_records_daily_attributed WHERE team_id IS NULL)
    = (SELECT sum(cost_usd) FROM cost_records));

-- ---------------------------------------------------------------------------
-- Access unchanged: authenticated can read the new columns, anon cannot.
-- ---------------------------------------------------------------------------
SET ROLE authenticated;
SELECT pg_temp.check('017: authenticated can read the new org_api_keys columns',
    (SELECT count(*) FROM org_api_keys WHERE external_status IS NOT NULL) = 4);
RESET ROLE;
SET ROLE anon;
DO $$
BEGIN
    PERFORM external_status FROM org_api_keys;
    RAISE EXCEPTION 'FAIL: 017: anon read org_api_keys';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: 017: anon has no access to org_api_keys';
END $$;
RESET ROLE;

-- Leave the shared fixtures as they were for the script's final re-apply.
DELETE FROM cost_records WHERE model_name LIKE 'a\_%' AND timestamp = '2026-11-04 00:00+00';
DELETE FROM org_api_keys WHERE external_key_id LIKE 'an\_%';
DELETE FROM org_projects WHERE external_project_id IN ('wrk_res', 'default')
    AND provider_id = (SELECT id FROM providers WHERE name = 'anthropic');
SELECT refresh_cost_records_daily();
SELECT pg_temp.check('017: fixtures removed, cost_records back to where they were',
    (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot)
    AND (SELECT sum(cost_usd) FROM cost_records) IS NOT DISTINCT FROM (SELECT s FROM before_snapshot));
