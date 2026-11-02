-- Assertions for issue #5 acceptance criteria 2 and 3, plus 011 (#7) projects.
-- Run after fixtures.sql. Any failure raises and stops psql (ON_ERROR_STOP).

CREATE FUNCTION pg_temp.check(label TEXT, ok BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL: %', label;
    END IF;
    RAISE NOTICE 'PASS: %', label;
END $$;

-- Readable projection of the attributed view: one row per fixture case.
CREATE TEMP VIEW att AS
SELECT
    pr.name AS provider,
    a.model_name AS model,
    a.date,
    pe.email AS person,
    k.external_key_id AS api_key,
    t.name AS team,
    d.name AS department,
    a.project_id,
    a.workspace_id,
    a.granularity,
    a.total_cost_usd,
    a.record_count
FROM cost_records_daily_attributed a
JOIN providers pr ON pr.id = a.provider_id
LEFT JOIN people pe ON pe.id = a.person_id
LEFT JOIN org_api_keys k ON k.id = a.org_api_key_id
LEFT JOIN teams t ON t.id = a.team_id
LEFT JOIN departments d ON d.id = a.department_id;

-- ---------------------------------------------------------------------------
-- 3. refresh_cost_records_daily() refreshes both views
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('3: both views empty before refresh (fixtures inserted after CREATE)',
    (SELECT count(*) FROM cost_records_daily) = 0
    AND (SELECT count(*) FROM cost_records_daily_attributed) = 0);

SELECT refresh_cost_records_daily();

SELECT pg_temp.check('3: refresh_cost_records_daily() populated cost_records_daily',
    (SELECT sum(record_count) FROM cost_records_daily) = (SELECT count(*) FROM cost_records));
SELECT pg_temp.check('3: refresh_cost_records_daily() populated cost_records_daily_attributed',
    (SELECT sum(record_count) FROM cost_records_daily_attributed) = (SELECT count(*) FROM cost_records));

-- ---------------------------------------------------------------------------
-- 2a. person_email -> person's team and department (case-insensitive)
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('2a: person_email maps to person, team, department',
    EXISTS (SELECT 1 FROM att WHERE model = 'a_email'
            AND person = 'alice@liatrio.com' AND team = 'Platform'
            AND department = 'Engineering' AND granularity = 'person'));

-- ---------------------------------------------------------------------------
-- 2b. api_key_id only -> key team, else owner's team
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('2b: api_key only, key without team -> owner and owner''s team',
    EXISTS (SELECT 1 FROM att WHERE model = 'b_key_owner'
            AND api_key = 'key_owner' AND person = 'bob@liatrio.com'
            AND team = 'Field' AND department = 'Sales'));
SELECT pg_temp.check('2b: api_key only, key with team -> key team (owner still the person)',
    EXISTS (SELECT 1 FROM att WHERE model = 'b_key_team'
            AND api_key = 'key_team' AND person = 'alice@liatrio.com'
            AND team = 'Data' AND department = 'Engineering'));

-- ---------------------------------------------------------------------------
-- 2c. key team beats person team
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('2c: key team beats person team',
    EXISTS (SELECT 1 FROM att WHERE model = 'c_key_beats_person'
            AND person = 'bob@liatrio.com' AND api_key = 'key_team'
            AND team = 'Data' AND department = 'Engineering'));

-- ---------------------------------------------------------------------------
-- 2d. no attribution -> Unassigned, granularity org
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('2d: rows without attribution land in Unassigned (org granularity)',
    (SELECT bool_and(person IS NULL AND api_key IS NULL AND team IS NULL
                     AND department IS NULL AND granularity = 'org')
       FROM att WHERE model = 'd_none')
    AND (SELECT sum(total_cost_usd) FROM att WHERE model = 'd_none') = 112);
SELECT pg_temp.check('2d: two unattributed rows on the same day share one Unassigned group',
    (SELECT record_count FROM att WHERE model = 'd_none' AND provider = 'openai') = 2);

-- ---------------------------------------------------------------------------
-- Remaining precedence rules
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('person_external_id via person_identities',
    EXISTS (SELECT 1 FROM att WHERE model = 'ext_id'
            AND person = 'bob@liatrio.com' AND team = 'Field'));
SELECT pg_temp.check('person_email via person_identities.external_id',
    EXISTS (SELECT 1 FROM att WHERE model = 'email_identity'
            AND person = 'dave@liatrio.com' AND team = 'Data' AND department = 'Engineering'));
SELECT pg_temp.check('people.email beats person_external_id',
    EXISTS (SELECT 1 FROM att WHERE model = 'email_beats_ext' AND person = 'alice@liatrio.com'));
SELECT pg_temp.check('person without team -> team and department Unassigned',
    EXISTS (SELECT 1 FROM att WHERE model = 'person_no_team'
            AND person = 'carol@liatrio.com' AND team IS NULL AND department IS NULL));
SELECT pg_temp.check('team without department -> department Unassigned',
    EXISTS (SELECT 1 FROM att WHERE model = 'team_no_dept'
            AND team = 'Orphan' AND department IS NULL));
SELECT pg_temp.check('unknown person and unknown key -> Unassigned',
    EXISTS (SELECT 1 FROM att WHERE model = 'unknown'
            AND person IS NULL AND api_key IS NULL AND team IS NULL AND granularity = 'api_key'));
SELECT pg_temp.check('registered key without owner/team keeps key and project, rest Unassigned',
    EXISTS (SELECT 1 FROM att WHERE model = 'key_bare'
            AND api_key = 'key_bare' AND person IS NULL AND team IS NULL
            AND project_id = 'proj_1' AND granularity = 'project'));
SELECT pg_temp.check('api_key_id only matches keys of the same provider',
    EXISTS (SELECT 1 FROM att WHERE model = 'key_wrong_provider'
            AND api_key IS NULL AND team IS NULL AND workspace_id = 'wrk_1'));
SELECT pg_temp.check('011: project team applies when there is no key or person team',
    EXISTS (SELECT 1 FROM att WHERE model = 'project_team'
            AND person IS NULL AND api_key IS NULL AND team = 'Field'
            AND department = 'Sales' AND project_id = 'proj_2'));
SELECT pg_temp.check('011: person team beats project team',
    EXISTS (SELECT 1 FROM att WHERE model = 'person_beats_project'
            AND person = 'alice@liatrio.com' AND team = 'Platform'));
SELECT pg_temp.check('011: person without a team falls back to the project team',
    EXISTS (SELECT 1 FROM att WHERE model = 'project_fallback'
            AND person = 'carol@liatrio.com' AND team = 'Field'));
SELECT pg_temp.check('011: project ids match per provider only (proj_1 unmapped stays Unassigned)',
    EXISTS (SELECT 1 FROM att WHERE model = 'key_bare' AND team IS NULL));
SELECT pg_temp.check('empty strings are absent; unknown granularity falls back to org',
    EXISTS (SELECT 1 FROM att WHERE model = 'empty_strings'
            AND person IS NULL AND api_key IS NULL AND granularity = 'org'));

-- ---------------------------------------------------------------------------
-- 2e. per-date totals reconcile with cost_records_daily
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.totals_reconcile() RETURNS BOOLEAN LANGUAGE sql AS $$
    WITH a AS (
        SELECT date, sum(total_cost_usd) c, sum(total_tokens) tk, sum(total_requests) rq, sum(record_count) n
        FROM cost_records_daily_attributed GROUP BY date
    ), d AS (
        SELECT date, sum(total_cost_usd) c, sum(total_tokens) tk, sum(total_requests) rq, sum(record_count) n
        FROM cost_records_daily GROUP BY date
    )
    SELECT count(*) = 0 FROM a FULL JOIN d USING (date)
    WHERE a.c IS DISTINCT FROM d.c OR a.tk IS DISTINCT FROM d.tk
       OR a.rq IS DISTINCT FROM d.rq OR a.n IS DISTINCT FROM d.n
$$;

SELECT pg_temp.check('2e: for every date, attributed totals equal cost_records_daily totals',
    pg_temp.totals_reconcile());
SELECT pg_temp.check('2e: attributed + Unassigned equals the org total',
    (SELECT sum(total_cost_usd) FROM cost_records_daily_attributed WHERE department_id IS NOT NULL)
    + (SELECT sum(total_cost_usd) FROM cost_records_daily_attributed WHERE department_id IS NULL)
    = (SELECT sum(cost_usd) FROM cost_records));

-- ---------------------------------------------------------------------------
-- Concurrent refresh with NULL keys, and current-state membership
-- ---------------------------------------------------------------------------
SELECT refresh_cost_records_daily();
SELECT refresh_cost_records_daily();
SELECT pg_temp.check('repeated CONCURRENTLY refresh is stable with NULL (Unassigned) keys',
    (SELECT count(*) FROM att WHERE model = 'd_none') = 2 AND pg_temp.totals_reconcile());

UPDATE people SET team_id = '70000000-0000-0000-0000-000000000002' WHERE email = 'alice@liatrio.com';
SELECT refresh_cost_records_daily();
SELECT pg_temp.check('reassigning a person moves their historical spend (current-state)',
    EXISTS (SELECT 1 FROM att WHERE model = 'a_email' AND team = 'Data')
    AND pg_temp.totals_reconcile());

INSERT INTO cost_records (user_id, provider_id, timestamp, model_name, cost_usd, collection_method, metadata)
SELECT '00000000-0000-0000-0000-000000000001', id, '2026-11-02 20:00+00', 'late', 9.00, 'api_automated',
       '{"attribution":{"person_email":"dave@liatrio.com","granularity":"person"}}'
FROM providers WHERE name = 'anthropic';
SELECT refresh_cost_records_daily();
SELECT pg_temp.check('new rows appear in both views after refresh',
    EXISTS (SELECT 1 FROM att WHERE model = 'late' AND team = 'Data')
    AND EXISTS (SELECT 1 FROM cost_records_daily WHERE model_name = 'late')
    AND pg_temp.totals_reconcile());

-- ---------------------------------------------------------------------------
-- Access: authenticated reads, cannot write; anon cannot read the rollup
-- ---------------------------------------------------------------------------
SET ROLE authenticated;
SELECT pg_temp.check('authenticated can read org tables and the attributed view',
    (SELECT count(*) FROM people) = 5
    AND (SELECT count(*) FROM org_api_keys) = 3
    AND (SELECT count(*) FROM org_projects) = 1
    AND (SELECT count(*) FROM cost_records_daily_attributed) > 0);
DO $$
BEGIN
    INSERT INTO org_projects (provider_id, external_project_id)
    SELECT id, 'sneaky' FROM providers LIMIT 1;
    RAISE EXCEPTION 'FAIL: authenticated could insert into org_projects';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated cannot write org_projects';
END $$;
DO $$
BEGIN
    INSERT INTO departments (name) VALUES ('Sneaky');
    RAISE EXCEPTION 'FAIL: authenticated could insert into departments';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated cannot write org tables';
END $$;
RESET ROLE;

SET ROLE anon;
DO $$
BEGIN
    PERFORM 1 FROM cost_records_daily_attributed LIMIT 1;
    RAISE EXCEPTION 'FAIL: anon could read cost_records_daily_attributed';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: anon cannot read cost_records_daily_attributed';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    INSERT INTO people (email) VALUES ('Mixed@Liatrio.com');
    RAISE EXCEPTION 'FAIL: mixed-case email accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: people.email must be lower-cased';
END $$;
DO $$
BEGIN
    INSERT INTO teams (name, department_id) VALUES ('Orphan', NULL);
    RAISE EXCEPTION 'FAIL: duplicate department-less team accepted';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: team names are unique within a department (including none)';
END $$;
