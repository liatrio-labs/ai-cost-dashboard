-- Fixtures for the migration assertions. Inserted AFTER all migrations, so
-- both materialized views are still empty until refresh_cost_records_daily().
--
-- Org:
--   Engineering: Platform, Data      Sales: Field      (no dept): Orphan
--   alice -> Platform   bob -> Field   carol -> (no team)
--   dave  -> Data       erin -> Orphan
-- Identities: anthropic 'user_bob' -> bob; cursor 'dave.alias@liatrio.com' -> dave
-- Projects (openai): proj_2 -> Field (011)
-- Keys (openai): key_team  (owner alice, team Data)
--                key_owner (owner bob,   no team)
--                key_bare  (no owner,    no team)

INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-000000000001', 'owner@example.com');

INSERT INTO departments (id, name) VALUES
    ('d0000000-0000-0000-0000-000000000001', 'Engineering'),
    ('d0000000-0000-0000-0000-000000000002', 'Sales');

INSERT INTO teams (id, name, department_id) VALUES
    ('70000000-0000-0000-0000-000000000001', 'Platform', 'd0000000-0000-0000-0000-000000000001'),
    ('70000000-0000-0000-0000-000000000002', 'Data',     'd0000000-0000-0000-0000-000000000001'),
    ('70000000-0000-0000-0000-000000000003', 'Field',    'd0000000-0000-0000-0000-000000000002'),
    ('70000000-0000-0000-0000-000000000004', 'Orphan',   NULL);

INSERT INTO people (id, email, display_name, team_id) VALUES
    ('a0000000-0000-0000-0000-00000000000a', 'alice@liatrio.com', 'Alice', '70000000-0000-0000-0000-000000000001'),
    ('a0000000-0000-0000-0000-00000000000b', 'bob@liatrio.com',   'Bob',   '70000000-0000-0000-0000-000000000003'),
    ('a0000000-0000-0000-0000-00000000000c', 'carol@liatrio.com', 'Carol', NULL),
    ('a0000000-0000-0000-0000-00000000000d', 'dave@liatrio.com',  'Dave',  '70000000-0000-0000-0000-000000000002'),
    ('a0000000-0000-0000-0000-00000000000e', 'erin@liatrio.com',  'Erin',  '70000000-0000-0000-0000-000000000004');

INSERT INTO person_identities (person_id, provider_id, external_id)
SELECT 'a0000000-0000-0000-0000-00000000000b', id, 'user_bob' FROM providers WHERE name = 'anthropic';
INSERT INTO person_identities (person_id, provider_id, external_id)
SELECT 'a0000000-0000-0000-0000-00000000000d', id, 'dave.alias@liatrio.com' FROM providers WHERE name = 'cursor';

INSERT INTO org_api_keys (id, provider_id, external_key_id, name, owner_person_id, team_id)
SELECT 'b0000000-0000-0000-0000-000000000001', id, 'key_team', 'Data pipeline key',
       'a0000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-000000000002'
FROM providers WHERE name = 'openai';
INSERT INTO org_api_keys (id, provider_id, external_key_id, name, owner_person_id, team_id)
SELECT 'b0000000-0000-0000-0000-000000000002', id, 'key_owner', 'Bob personal key',
       'a0000000-0000-0000-0000-00000000000b', NULL
FROM providers WHERE name = 'openai';
INSERT INTO org_api_keys (id, provider_id, external_key_id, name, owner_person_id, team_id)
SELECT 'b0000000-0000-0000-0000-000000000003', id, 'key_bare', 'Unowned key', NULL, NULL
FROM providers WHERE name = 'openai';

-- Projects (011): openai proj_2 -> Field; proj_1 is deliberately unmapped.
INSERT INTO org_projects (id, provider_id, external_project_id, name, team_id)
SELECT 'c0000000-0000-0000-0000-000000000001', id, 'proj_2', 'Sales tools',
       '70000000-0000-0000-0000-000000000003'
FROM providers WHERE name = 'openai';

-- cost_records. The model_name is a test label naming the case it covers,
-- so assertions can find each row's rollup by (provider, model_name).
CREATE TEMP TABLE fx (provider TEXT, ts TIMESTAMPTZ, model TEXT, cost NUMERIC, meta JSONB);
INSERT INTO fx VALUES
    -- (a) person_email (mixed case) -> alice / Platform / Engineering
    ('anthropic', '2026-11-01 10:00+00', 'a_email',            1.00, '{"attribution":{"person_email":"ALICE@liatrio.com","granularity":"person"}}'),
    -- (b) api_key only, key has no team -> owner bob's team Field / Sales
    ('openai',    '2026-11-01 11:00+00', 'b_key_owner',        2.00, '{"attribution":{"api_key_id":"key_owner","granularity":"api_key"}}'),
    -- (b) api_key only, key has a team -> key team Data / Engineering (owner alice)
    ('openai',    '2026-11-01 12:00+00', 'b_key_team',         4.00, '{"attribution":{"api_key_id":"key_team","granularity":"api_key"}}'),
    -- (c) key team beats person team: bob (Field) on key_team (Data)
    ('openai',    '2026-11-01 13:00+00', 'c_key_beats_person', 8.00, '{"attribution":{"person_email":"bob@liatrio.com","api_key_id":"key_team","granularity":"api_key"}}'),
    -- (d) no attribution at all (legacy rows), two rows that share a group
    ('openai',    '2026-11-01 14:00+00', 'd_none',            16.00, '{}'),
    ('openai',    '2026-11-01 15:00+00', 'd_none',            32.00, '{"member_email":"bob@liatrio.com"}'),
    ('cursor',    '2026-11-02 09:00+00', 'd_none',            64.00, NULL),
    -- person_external_id via person_identities -> bob
    ('anthropic', '2026-11-02 10:00+00', 'ext_id',           128.00, '{"attribution":{"person_external_id":"user_bob","granularity":"person"}}'),
    -- person_email via person_identities.external_id -> dave / Data
    ('cursor',    '2026-11-02 11:00+00', 'email_identity',   256.00, '{"attribution":{"person_email":"dave.alias@liatrio.com","granularity":"person"}}'),
    -- people.email wins over person_external_id
    ('anthropic', '2026-11-02 12:00+00', 'email_beats_ext',  512.00, '{"attribution":{"person_email":"alice@liatrio.com","person_external_id":"user_bob","granularity":"person"}}'),
    -- person with no team -> team/department Unassigned
    ('anthropic', '2026-11-02 13:00+00', 'person_no_team',     0.50, '{"attribution":{"person_email":"carol@liatrio.com","granularity":"person"}}'),
    -- team with no department -> department Unassigned
    ('anthropic', '2026-11-02 14:00+00', 'team_no_dept',       0.25, '{"attribution":{"person_email":"erin@liatrio.com","granularity":"person"}}'),
    -- unknown person and unknown key -> Unassigned
    ('openai',    '2026-11-02 15:00+00', 'unknown',            0.125,'{"attribution":{"person_email":"ghost@example.com","api_key_id":"key_missing","granularity":"api_key"}}'),
    -- registered key with no owner/team -> key set, person/team Unassigned
    ('openai',    '2026-11-02 16:00+00', 'key_bare',           3.00, '{"attribution":{"api_key_id":"key_bare","project_id":"proj_1","granularity":"project"}}'),
    -- key id is per provider: anthropic has no key_team
    ('anthropic', '2026-11-02 17:00+00', 'key_wrong_provider', 5.00, '{"attribution":{"api_key_id":"key_team","workspace_id":"wrk_1","granularity":"workspace"}}'),
    -- (011) project with a team, no person/key -> project team Field / Sales
    ('openai',    '2026-11-02 19:00+00', 'project_team',       0.75, '{"attribution":{"project_id":"proj_2","granularity":"project"}}'),
    -- (011) person team beats project team: alice (Platform) in proj_2 (Field)
    ('openai',    '2026-11-02 19:30+00', 'person_beats_project', 1.50, '{"attribution":{"person_email":"alice@liatrio.com","project_id":"proj_2","granularity":"person"}}'),
    -- (011) person without team falls back to the project team
    ('openai',    '2026-11-02 19:45+00', 'project_fallback',   2.50, '{"attribution":{"person_email":"carol@liatrio.com","project_id":"proj_2","granularity":"person"}}'),
    -- empty strings count as absent; bad granularity falls back to org
    ('openai',    '2026-11-02 18:00+00', 'empty_strings',      7.00, '{"attribution":{"person_email":"","api_key_id":"","granularity":"bogus"}}');

INSERT INTO cost_records (user_id, provider_id, timestamp, model_name, cost_usd,
                          tokens_used, input_tokens, output_tokens, request_count,
                          collection_method, metadata)
SELECT '00000000-0000-0000-0000-000000000001', p.id, fx.ts, fx.model, fx.cost,
       100, 60, 40, 1, 'api_automated', fx.meta
FROM fx JOIN providers p ON p.name = fx.provider;
