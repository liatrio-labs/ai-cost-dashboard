-- Assertions for 015 (issue #24): AI Gateway key -> person / project.
-- Runs after assertions.sql, with 015 applied twice over the fixtures. Adds
-- its own gateway fixtures (assertions.sql counts the 010/011 rows), then
-- refreshes and checks the view. Any failure raises (ON_ERROR_STOP).
--
-- By the time this runs, assertions.sql has moved alice to Data.
--
-- Gateway projects: prj_web -> Platform, prj_nt (no team)
-- Gateway keys:
--   gk_user          owner carol (no team), spend_attribution user, auto
--   gk_user_team     owner bob (Field), auto
--   gk_proj          project-scoped: org_project_id prj_web, no owner
--   gk_keyproj       org_project_id prj_web (rows carry no project_id)
--   gk_rowproj       org_project_id prj_web, rows carry project_id prj_nt
--   gk_person_proj   owner dave (Data) + org_project_id prj_web
--   gk_key_team      team Field + owner dave + org_project_id prj_web
--   gk_xprov         org_project_id = openai proj_2 (Field): other provider

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
SELECT pg_temp.check('015: org_api_keys has the gateway columns',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'org_api_keys'
        AND column_name IN ('org_project_id', 'external_created_by', 'external_created_by_email',
                            'spend_attribution', 'assignment_source')) = 5);
SELECT pg_temp.check('015: keys assigned by hand before 015 are marked manual, unassigned keys stay NULL',
    (SELECT assignment_source FROM org_api_keys WHERE external_key_id = 'key_team') = 'manual'
    AND (SELECT assignment_source FROM org_api_keys WHERE external_key_id = 'key_owner') = 'manual'
    AND (SELECT assignment_source FROM org_api_keys WHERE external_key_id = 'key_bare') IS NULL);
DO $$
BEGIN
    UPDATE org_api_keys SET spend_attribution = 'everyone' WHERE external_key_id = 'key_bare';
    RAISE EXCEPTION 'FAIL: bad spend_attribution accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 015: spend_attribution must be user, team or NULL';
END $$;
DO $$
BEGIN
    UPDATE org_api_keys SET assignment_source = 'magic' WHERE external_key_id = 'key_bare';
    RAISE EXCEPTION 'FAIL: bad assignment_source accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 015: assignment_source must be auto, manual or NULL';
END $$;

-- ---------------------------------------------------------------------------
-- Gateway fixtures
-- ---------------------------------------------------------------------------
INSERT INTO org_projects (id, provider_id, external_project_id, name, team_id)
SELECT 'c0000000-0000-0000-0000-0000000000a1', id, 'prj_web', 'Website', '70000000-0000-0000-0000-000000000001'
FROM providers WHERE name = 'vercel-ai-gateway';
INSERT INTO org_projects (id, provider_id, external_project_id, name, team_id)
SELECT 'c0000000-0000-0000-0000-0000000000a2', id, 'prj_nt', 'No team yet', NULL
FROM providers WHERE name = 'vercel-ai-gateway';

CREATE TEMP TABLE gk (ext TEXT, owner TEXT, team TEXT, project UUID, spend TEXT, source TEXT);
INSERT INTO gk VALUES
    ('gk_user',        'carol@liatrio.com', NULL,    NULL,                                   'user', 'auto'),
    ('gk_user_team',   'bob@liatrio.com',   NULL,    NULL,                                   'user', 'auto'),
    ('gk_proj',        NULL,                NULL,    'c0000000-0000-0000-0000-0000000000a1', 'team', 'auto'),
    ('gk_keyproj',     NULL,                NULL,    'c0000000-0000-0000-0000-0000000000a1', NULL,   'manual'),
    ('gk_rowproj',     NULL,                NULL,    'c0000000-0000-0000-0000-0000000000a1', 'team', 'auto'),
    ('gk_person_proj', 'dave@liatrio.com',  NULL,    'c0000000-0000-0000-0000-0000000000a1', 'user', 'auto'),
    ('gk_key_team',    'dave@liatrio.com',  'Field', 'c0000000-0000-0000-0000-0000000000a1', 'user', 'manual'),
    ('gk_xprov',       NULL,                NULL,    'c0000000-0000-0000-0000-000000000001', 'team', 'manual');

INSERT INTO org_api_keys (provider_id, external_key_id, name, owner_person_id, team_id, org_project_id,
                          external_created_by, spend_attribution, assignment_source)
SELECT p.id, gk.ext, gk.ext, pe.id, t.id, gk.project, 'uid_' || gk.ext, gk.spend, gk.source
FROM gk
JOIN providers p ON p.name = 'vercel-ai-gateway'
LEFT JOIN people pe ON pe.email = gk.owner
LEFT JOIN teams t ON t.name = gk.team;

CREATE TEMP TABLE gfx (model TEXT, cost NUMERIC, meta JSONB);
INSERT INTO gfx VALUES
    ('g_user',         1.00, '{"attribution":{"api_key_id":"gk_user","granularity":"api_key"}}'),
    ('g_user_team',    2.00, '{"attribution":{"api_key_id":"gk_user_team","granularity":"api_key"}}'),
    ('g_proj',         4.00, '{"attribution":{"api_key_id":"gk_proj","project_id":"prj_web","project_name":"Website","granularity":"api_key"}}'),
    ('g_keyproj',      8.00, '{"attribution":{"api_key_id":"gk_keyproj","granularity":"api_key"}}'),
    ('g_rowproj',     16.00, '{"attribution":{"api_key_id":"gk_rowproj","project_id":"prj_nt","granularity":"api_key"}}'),
    ('g_person_proj', 32.00, '{"attribution":{"api_key_id":"gk_person_proj","granularity":"api_key"}}'),
    ('g_key_team',    64.00, '{"attribution":{"api_key_id":"gk_key_team","granularity":"api_key"}}'),
    ('g_xprov',      128.00, '{"attribution":{"api_key_id":"gk_xprov","granularity":"api_key"}}'),
    ('g_remainder',  256.00, '{"remainder":true,"attribution":{"granularity":"org"}}');

INSERT INTO cost_records (user_id, provider_id, timestamp, model_name, cost_usd,
                          tokens_used, input_tokens, output_tokens, request_count,
                          collection_method, metadata)
SELECT '00000000-0000-0000-0000-000000000001', p.id, '2026-11-03 00:00+00', gfx.model, gfx.cost,
       10, 6, 4, 1, 'api_automated', gfx.meta
FROM gfx JOIN providers p ON p.name = 'vercel-ai-gateway';

SELECT refresh_cost_records_daily();

CREATE TEMP VIEW gatt AS
SELECT
    a.model_name AS model,
    pe.email AS person,
    k.external_key_id AS api_key,
    t.name AS team,
    d.name AS department,
    a.project_id,
    a.granularity,
    a.total_cost_usd
FROM cost_records_daily_attributed a
JOIN providers pr ON pr.id = a.provider_id AND pr.name = 'vercel-ai-gateway'
LEFT JOIN people pe ON pe.id = a.person_id
LEFT JOIN org_api_keys k ON k.id = a.org_api_key_id
LEFT JOIN teams t ON t.id = a.team_id
LEFT JOIN departments d ON d.id = a.department_id;

-- ---------------------------------------------------------------------------
-- Precedence
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('015: user-attributed key resolves to its owner (owner without a team -> team Unassigned)',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_user'
            AND api_key = 'gk_user' AND person = 'carol@liatrio.com' AND team IS NULL AND project_id IS NULL));
SELECT pg_temp.check('015: user-attributed key -> owner -> owner''s team',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_user_team'
            AND person = 'bob@liatrio.com' AND team = 'Field' AND department = 'Sales'));
SELECT pg_temp.check('015: project-scoped key resolves to its project and the project''s team',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_proj'
            AND person IS NULL AND project_id = 'prj_web' AND team = 'Platform' AND department = 'Engineering'));
SELECT pg_temp.check('015: key org_project_id applies when the row has no project_id',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_keyproj'
            AND project_id = 'prj_web' AND team = 'Platform'));
SELECT pg_temp.check('015: the row''s project_id beats the key''s project',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_rowproj'
            AND project_id = 'prj_nt' AND team IS NULL));
SELECT pg_temp.check('015: person team beats project team',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_person_proj'
            AND person = 'dave@liatrio.com' AND project_id = 'prj_web' AND team = 'Data'));
SELECT pg_temp.check('015: key team beats person and project team',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_key_team'
            AND person = 'dave@liatrio.com' AND project_id = 'prj_web' AND team = 'Field'));
SELECT pg_temp.check('015: a key project from another provider is ignored',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_xprov'
            AND api_key = 'gk_xprov' AND project_id IS NULL AND team IS NULL));
SELECT pg_temp.check('015: remainder row stays org-level Unassigned',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_remainder'
            AND person IS NULL AND api_key IS NULL AND team IS NULL AND project_id IS NULL AND granularity = 'org'));
SELECT pg_temp.check('015: one view row per gateway fixture (no fan-out)',
    (SELECT count(*) FROM gatt) = 9
    AND (SELECT sum(total_cost_usd) FROM gatt) = 511);

-- ---------------------------------------------------------------------------
-- Totals still reconcile
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('015: for every date, attributed totals equal cost_records_daily totals',
    (SELECT count(*) FROM (
        SELECT date, sum(total_cost_usd) c, sum(total_tokens) tk, sum(record_count) n
        FROM cost_records_daily_attributed GROUP BY date
    ) a FULL JOIN (
        SELECT date, sum(total_cost_usd) c, sum(total_tokens) tk, sum(record_count) n
        FROM cost_records_daily GROUP BY date
    ) d USING (date)
    WHERE a.c IS DISTINCT FROM d.c OR a.tk IS DISTINCT FROM d.tk OR a.n IS DISTINCT FROM d.n) = 0);
SELECT pg_temp.check('015: attributed + Unassigned equals the org total',
    (SELECT sum(total_cost_usd) FROM cost_records_daily_attributed WHERE team_id IS NOT NULL)
    + (SELECT sum(total_cost_usd) FROM cost_records_daily_attributed WHERE team_id IS NULL)
    = (SELECT sum(cost_usd) FROM cost_records));

-- ---------------------------------------------------------------------------
-- ON DELETE SET NULL, then clean up
-- ---------------------------------------------------------------------------
DELETE FROM org_projects WHERE external_project_id = 'prj_nt';
SELECT pg_temp.check('015: deleting a project keeps the key (org_project_id unaffected for other projects)',
    (SELECT org_project_id FROM org_api_keys WHERE external_key_id = 'gk_rowproj')
        = 'c0000000-0000-0000-0000-0000000000a1');
DELETE FROM org_projects WHERE external_project_id = 'prj_web';
SELECT pg_temp.check('015: deleting a project sets org_project_id NULL on its keys',
    (SELECT count(*) FROM org_api_keys WHERE org_project_id = 'c0000000-0000-0000-0000-0000000000a1') = 0
    AND (SELECT count(*) FROM org_api_keys WHERE external_key_id LIKE 'gk_%') = 8);
SELECT refresh_cost_records_daily();
SELECT pg_temp.check('015: with the project gone its spend falls back to Unassigned, totals unchanged',
    EXISTS (SELECT 1 FROM gatt WHERE model = 'g_proj' AND team IS NULL AND project_id = 'prj_web')
    AND EXISTS (SELECT 1 FROM gatt WHERE model = 'g_keyproj' AND team IS NULL AND project_id IS NULL)
    AND (SELECT sum(total_cost_usd) FROM gatt) = 511);

-- ---------------------------------------------------------------------------
-- Access (same as 010/011/014)
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('015: anon has no access to the rollup or org_api_keys; RLS stays on org_api_keys',
    NOT has_table_privilege('anon', 'public.cost_records_daily_attributed', 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('anon', 'public.org_api_keys', 'SELECT,INSERT,UPDATE,DELETE')
    AND has_table_privilege('authenticated', 'public.cost_records_daily_attributed', 'SELECT')
    AND has_table_privilege('service_role', 'public.org_api_keys', 'SELECT,INSERT,UPDATE,DELETE')
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.org_api_keys'::regclass));
SET ROLE authenticated;
SELECT pg_temp.check('015: authenticated can read the new org_api_keys columns',
    (SELECT count(*) FROM org_api_keys WHERE assignment_source = 'manual') >= 2);
DO $$
DECLARE
    n INT;
BEGIN
    UPDATE org_api_keys SET assignment_source = 'auto' WHERE external_key_id = 'key_team';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'FAIL: authenticated updated org_api_keys';
    END IF;
    RAISE NOTICE 'PASS: 015: authenticated cannot change org_api_keys (RLS: no write policy)';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: 015: authenticated cannot change org_api_keys (RLS: no write policy)';
END $$;
RESET ROLE;
SELECT pg_temp.check('015: PUBLIC holds no ACL entry on the rollup',
    NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                 WHERE a.grantee = 0 AND c.oid = 'public.cost_records_daily_attributed'::regclass));

-- Leave the shared fixtures as they were for the script's final re-apply.
DELETE FROM cost_records WHERE model_name LIKE 'g\_%';
DELETE FROM org_api_keys WHERE external_key_id LIKE 'gk\_%';
SELECT refresh_cost_records_daily();
