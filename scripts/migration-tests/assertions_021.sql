-- Assertions for 021 (issue #51): merge_people() and person_merges, checked
-- against the real cost_records_daily_attributed view.
-- Runs after assertions.sql and _015 to _017, with 021 applied twice over the
-- fixtures. Adds its own fixtures and removes them at the end.
-- Any failure raises (ON_ERROR_STOP).
--
-- Duplicates: Jane Doe twice.
--   primary   f...01 jane@liatrio.com   "Jane Doe", no team
--   secondary f...02 jane@liatrio.io    "Jane Doe", team Field
--     identities: anthropic user_jane, cursor jane.cursor@liatrio.io
--     owns openai key key_jane
--     claude-max seat rows (2026-11): 2 assigned to jane@liatrio.io
--   cost rows (2026-11-06): anthropic jane@liatrio.com 5, anthropic user_jane 7,
--     cursor jane.cursor@liatrio.io 11, cursor jane@liatrio.io 13 (alias path),
--     openai key_jane 17, seats 40 + 60.
--   bystander f...03 jd@liatrio.com (not touched)

CREATE FUNCTION pg_temp.check(label TEXT, ok BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL: %', label;
    END IF;
    RAISE NOTICE 'PASS: %', label;
END $$;

CREATE TEMP TABLE before_snapshot AS
SELECT count(*) AS n, sum(cost_usd) AS s FROM cost_records;

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('021: person_merges exists with RLS on',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.person_merges'::regclass));
SELECT pg_temp.check('021: merge_people executable by service_role only',
    has_function_privilege('service_role', 'public.merge_people(uuid, uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.merge_people(uuid, uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.merge_people(uuid, uuid, text)', 'EXECUTE'));
SELECT pg_temp.check('021: person_merges not readable by anon or authenticated',
    NOT has_table_privilege('anon', 'public.person_merges', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.person_merges', 'SELECT')
    AND has_table_privilege('service_role', 'public.person_merges', 'INSERT'));
SELECT pg_temp.check('021: merge_people has a pinned search_path and is SECURITY INVOKER',
    (SELECT 'search_path=public, pg_temp' = ANY (proconfig) AND NOT prosecdef
       FROM pg_proc WHERE oid = 'public.merge_people(uuid, uuid, text)'::regprocedure));

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO people (id, email, display_name, team_id) VALUES
    ('f0000000-0000-0000-0000-000000000001', 'jane@liatrio.com', 'Jane Doe', NULL),
    ('f0000000-0000-0000-0000-000000000002', 'jane@liatrio.io',  'Jane Doe', '70000000-0000-0000-0000-000000000003'),
    ('f0000000-0000-0000-0000-000000000003', 'jd@liatrio.com',   'J D',      NULL);
INSERT INTO person_identities (person_id, provider_id, external_id)
SELECT 'f0000000-0000-0000-0000-000000000002', id, 'user_jane' FROM providers WHERE name = 'anthropic';
INSERT INTO person_identities (person_id, provider_id, external_id)
SELECT 'f0000000-0000-0000-0000-000000000002', id, 'jane.cursor@liatrio.io' FROM providers WHERE name = 'cursor';
INSERT INTO org_api_keys (id, provider_id, external_key_id, name, owner_person_id, team_id)
SELECT 'f1000000-0000-0000-0000-000000000001', id, 'key_jane', 'Jane key', 'f0000000-0000-0000-0000-000000000002', NULL
FROM providers WHERE name = 'openai';

CREATE TEMP TABLE jfx (provider TEXT, model TEXT, cost NUMERIC, method TEXT, meta JSONB);
INSERT INTO jfx VALUES
    ('anthropic', 'j_own',    5, 'api_automated', '{"attribution": {"granularity": "person", "person_email": "jane@liatrio.com"}}'),
    ('anthropic', 'j_actor',  7, 'api_automated', '{"attribution": {"granularity": "person", "person_external_id": "user_jane"}}'),
    ('cursor',    'j_ident', 11, 'api_automated', '{"attribution": {"granularity": "person", "person_email": "jane.cursor@liatrio.io"}}'),
    ('cursor',    'j_alias', 13, 'api_automated', '{"attribution": {"granularity": "person", "person_email": "jane@liatrio.io"}}'),
    ('openai',    'j_key',   17, 'api_automated', '{"attribution": {"granularity": "api_key", "api_key_id": "key_jane"}}'),
    ('claude-max','j_seat',  40, 'manual_entry',  '{"entry_type": "monthly_seats", "month": "2026-11", "seat_group_id": "g021", "attribution": {"granularity": "person", "person_email": "jane@liatrio.io"}}'),
    ('claude-max','j_seat',  60, 'manual_entry',  '{"entry_type": "monthly_seats", "month": "2026-11", "seat_group_id": "g021", "attribution": {"granularity": "person", "person_email": " Jane@Liatrio.io"}}'),
    ('claude-max','j_seat',   9, 'manual_entry',  '{"entry_type": "monthly_seats", "month": "2026-11", "seat_group_id": "g021", "attribution": {"granularity": "org"}}');
INSERT INTO cost_records (user_id, provider_id, timestamp, model_name, cost_usd,
                          tokens_used, input_tokens, output_tokens, request_count,
                          collection_method, metadata)
SELECT '00000000-0000-0000-0000-000000000001', p.id, '2026-11-06 00:00+00', j.model, j.cost,
       10, 6, 4, 1, j.method, j.meta
FROM jfx j JOIN providers p ON p.name = j.provider;

SELECT refresh_cost_records_daily();

CREATE TEMP TABLE jane_before AS
SELECT person_id, sum(total_cost_usd) AS c FROM cost_records_daily_attributed
 WHERE date = '2026-11-06' AND model_name LIKE 'j\_%' GROUP BY person_id;
SELECT pg_temp.check('021: before the merge Jane''s spend is split across both records',
    (SELECT c FROM jane_before WHERE person_id = 'f0000000-0000-0000-0000-000000000001') = 5
    AND (SELECT c FROM jane_before WHERE person_id = 'f0000000-0000-0000-0000-000000000002') = 148);
SELECT pg_temp.check('021: the org remainder seat row stays Unassigned',
    (SELECT c FROM jane_before WHERE person_id IS NULL) = 9);

-- ---------------------------------------------------------------------------
-- Refusals
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    PERFORM merge_people('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL: self-merge accepted';
EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS: 021: refuses merging a person into themselves';
END $$;
DO $$
BEGIN
    PERFORM merge_people('f0000000-0000-0000-0000-0000000000ff', 'f0000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FAIL: unknown primary accepted';
EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS: 021: refuses an unknown primary (nothing changed: %)', SQLERRM;
END $$;
SELECT pg_temp.check('021: a refused merge changes nothing',
    (SELECT count(*) FROM people WHERE id = 'f0000000-0000-0000-0000-000000000002') = 1
    AND (SELECT count(*) FROM person_merges) = 0);
SET ROLE authenticated;
DO $$
BEGIN
    PERFORM merge_people('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FAIL: authenticated could merge';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: 021: authenticated cannot call merge_people';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Merge (as the admin route does: service_role)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE merge1 (r JSONB);
GRANT ALL ON merge1 TO service_role;
SET ROLE service_role;
INSERT INTO merge1
SELECT merge_people('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002', 'admin@example.com');
RESET ROLE;

SELECT pg_temp.check('021: merge reports the moved counts',
    (SELECT (r ->> 'already_merged')::boolean = false
        AND (r ->> 'identities_moved')::int = 2
        AND (r ->> 'keys_moved')::int = 1
        AND (r ->> 'seat_rows_moved')::int = 2
        AND (r ->> 'aliases_added')::int = (SELECT count(*) FROM providers)
        AND (r ->> 'team_adopted')::boolean
        AND NOT (r ->> 'display_name_adopted')::boolean
     FROM merge1));
SELECT pg_temp.check('021: secondary deleted and logged',
    (SELECT count(*) FROM people WHERE id = 'f0000000-0000-0000-0000-000000000002') = 0
    AND (SELECT count(*) FROM person_merges
          WHERE secondary_person_id = 'f0000000-0000-0000-0000-000000000002'
            AND primary_person_id = 'f0000000-0000-0000-0000-000000000001'
            AND secondary_email = 'jane@liatrio.io' AND merged_by = 'admin@example.com') = 1);
SELECT pg_temp.check('021: identities, key owner and seat rows now point at the primary',
    (SELECT count(*) FROM person_identities WHERE person_id = 'f0000000-0000-0000-0000-000000000001'
        AND external_id IN ('user_jane', 'jane.cursor@liatrio.io')) = 2
    AND (SELECT owner_person_id FROM org_api_keys WHERE external_key_id = 'key_jane') = 'f0000000-0000-0000-0000-000000000001'
    AND (SELECT count(*) FROM cost_records WHERE model_name = 'j_seat'
          AND metadata -> 'attribution' ->> 'person_email' = 'jane@liatrio.com') = 2
    AND (SELECT count(*) FROM cost_records WHERE model_name = 'j_seat'
          AND metadata -> 'attribution' ->> 'granularity' = 'org'
          AND NOT (metadata -> 'attribution' ? 'person_email')) = 1);
SELECT pg_temp.check('021: primary keeps its name, adopts the secondary''s team',
    (SELECT display_name = 'Jane Doe' AND team_id = '70000000-0000-0000-0000-000000000003'
       FROM people WHERE id = 'f0000000-0000-0000-0000-000000000001'));
SELECT pg_temp.check('021: bystander with a similar name untouched',
    (SELECT count(*) FROM people WHERE id = 'f0000000-0000-0000-0000-000000000003') = 1);

SELECT refresh_cost_records_daily();
SELECT pg_temp.check('021: after refresh all of Jane''s spend is on the primary (5 + 148), team Field',
    (SELECT sum(total_cost_usd) FROM cost_records_daily_attributed
      WHERE date = '2026-11-06' AND model_name LIKE 'j\_%'
        AND person_id = 'f0000000-0000-0000-0000-000000000001') = 153
    AND (SELECT count(*) FROM cost_records_daily_attributed
      WHERE date = '2026-11-06' AND model_name LIKE 'j\_%'
        AND person_id = 'f0000000-0000-0000-0000-000000000001'
        AND team_id IS DISTINCT FROM '70000000-0000-0000-0000-000000000003') = 0);
SELECT pg_temp.check('021: the old email reaches the primary through the alias',
    (SELECT person_id FROM cost_records_daily_attributed
      WHERE date = '2026-11-06' AND model_name = 'j_alias') = 'f0000000-0000-0000-0000-000000000001');
SELECT pg_temp.check('021: cost_records count and sum unchanged by the merge',
    (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot) + 8
    AND (SELECT sum(cost_usd) FROM cost_records) = (SELECT s FROM before_snapshot) + 162);
SELECT pg_temp.check('021: attributed totals still reconcile with cost_records_daily',
    (SELECT count(*) FROM (
        SELECT date, sum(total_cost_usd) c FROM cost_records_daily_attributed GROUP BY date
     ) a FULL JOIN (
        SELECT date, sum(total_cost_usd) c FROM cost_records_daily GROUP BY date
     ) d USING (date) WHERE a.c IS DISTINCT FROM d.c) = 0);

-- ---------------------------------------------------------------------------
-- Idempotent: the same merge again changes nothing and reports the original
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE state_after AS
SELECT (SELECT count(*) FROM people) AS people,
       (SELECT count(*) FROM person_identities) AS identities,
       (SELECT count(*) FROM person_merges) AS merges,
       (SELECT md5(string_agg(id::text || metadata::text, ',' ORDER BY id)) FROM cost_records) AS rows_md5;
CREATE TEMP TABLE merge2 (r JSONB);
GRANT ALL ON merge2 TO service_role;
SET ROLE service_role;
INSERT INTO merge2
SELECT merge_people('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002');
RESET ROLE;
SELECT pg_temp.check('021: repeating a merge returns already_merged with the original counts',
    (SELECT (m2.r ->> 'already_merged')::boolean
        AND (m2.r - 'already_merged' - 'merged_at') = (m1.r - 'already_merged')
     FROM merge1 m1, merge2 m2));
SELECT pg_temp.check('021: repeating a merge changes nothing',
    (SELECT people = (SELECT count(*) FROM people)
        AND identities = (SELECT count(*) FROM person_identities)
        AND merges = (SELECT count(*) FROM person_merges)
        AND rows_md5 = (SELECT md5(string_agg(id::text || metadata::text, ',' ORDER BY id)) FROM cost_records)
     FROM state_after));
DO $$
BEGIN
    PERFORM merge_people('f0000000-0000-0000-0000-000000000003', 'f0000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FAIL: merged-away person merged again into someone else';
EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS: 021: a merged-away person cannot be merged into someone else (%)', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- Leave the shared fixtures as they were for the script's final re-apply.
-- ---------------------------------------------------------------------------
DELETE FROM cost_records WHERE model_name LIKE 'j\_%' AND timestamp = '2026-11-06 00:00+00';
DELETE FROM org_api_keys WHERE external_key_id = 'key_jane';
DELETE FROM person_merges;
DELETE FROM people WHERE id IN ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000003');
SELECT refresh_cost_records_daily();
SELECT pg_temp.check('021: fixtures removed, cost_records back to where they were',
    (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot)
    AND (SELECT sum(cost_usd) FROM cost_records) IS NOT DISTINCT FROM (SELECT s FROM before_snapshot)
    AND (SELECT count(*) FROM person_identities WHERE external_id IN ('jane@liatrio.io', 'user_jane', 'jane.cursor@liatrio.io')) = 0);
