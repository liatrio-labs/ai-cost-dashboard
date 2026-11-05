-- Assertions for 025 (issue #76): Cursor billing-cycle spend snapshots.
-- Runs after assertions.sql and the earlier assertions_NNN.sql, with 025
-- applied twice over the fixtures. Fixture amounts only. The cursor tables
-- are left holding the test cycles (they are independent of cost_records,
-- which is checked unchanged). Any failure raises (ON_ERROR_STOP).

CREATE FUNCTION pg_temp.check(label TEXT, ok BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL: %', label;
    END IF;
    RAISE NOTICE 'PASS: %', label;
END $$;

-- Expect a statement to fail; returns true when it raised.
CREATE FUNCTION pg_temp.raises(stmt TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE stmt;
    RETURN false;
EXCEPTION WHEN OTHERS THEN
    RETURN true;
END $$;

CREATE TEMP TABLE before_snapshot AS
SELECT count(*) AS n, sum(cost_usd) AS s FROM cost_records;

-- ---------------------------------------------------------------------------
-- Schema and access
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('025: cursor tables exist, empty, RLS on',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cursor_spend_cycles'::regclass)
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cursor_member_cycle_spend'::regclass)
    AND (SELECT count(*) FROM cursor_spend_cycles) = 0
    AND (SELECT count(*) FROM cursor_member_cycle_spend) = 0);
SELECT pg_temp.check('025: authenticated may SELECT but not write the cursor tables',
    has_table_privilege('authenticated', 'public.cursor_spend_cycles', 'SELECT')
    AND has_table_privilege('authenticated', 'public.cursor_member_cycle_spend', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.cursor_spend_cycles', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.cursor_member_cycle_spend', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.cursor_member_cycle_spend', 'DELETE'));
SELECT pg_temp.check('025: anon has no access to the cursor tables',
    NOT has_table_privilege('anon', 'public.cursor_spend_cycles', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.cursor_member_cycle_spend', 'SELECT'));
SELECT pg_temp.check('025: only service_role executes record_cursor_spend_snapshot',
    has_function_privilege('service_role', 'public.record_cursor_spend_snapshot(timestamptz,timestamptz,text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.record_cursor_spend_snapshot(timestamptz,timestamptz,text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.record_cursor_spend_snapshot(timestamptz,timestamptz,text,jsonb)', 'EXECUTE'));

-- ---------------------------------------------------------------------------
-- Snapshots of the Oct 19 cycle: member and team spendCents totals
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('025: first Oct 19 snapshot is inserted',
    record_cursor_spend_snapshot('2026-10-19T00:00:00Z', '2026-10-20T01:05:00Z', 'team-1', '[
      {"email": "Alice@Example.com", "name": "Alice", "cursor_user_id": "101", "role": "member",
       "spend_cents": 1000, "overall_spend_cents": 8000,
       "monthly_limit_dollars": 100, "hard_limit_override_dollars": null, "effective_per_user_limit_dollars": 100},
      {"email": "bob@example.com", "name": "Bob", "role": "owner",
       "spend_cents": 0, "overall_spend_cents": 4000,
       "monthly_limit_dollars": 100, "hard_limit_override_dollars": 250, "effective_per_user_limit_dollars": 250}
    ]'::jsonb) = 'inserted');

SELECT pg_temp.check('025: a later Oct 19 snapshot updates the running cycle',
    record_cursor_spend_snapshot('2026-10-19T00:00:00Z', '2026-11-19T00:05:00Z', 'team-1', '[
      {"email": "alice@example.com", "name": "Alice", "cursor_user_id": "101", "role": "member",
       "spend_cents": 2450, "overall_spend_cents": 9450,
       "monthly_limit_dollars": 100, "hard_limit_override_dollars": null, "effective_per_user_limit_dollars": 100},
      {"email": "bob@example.com", "name": "Bob", "role": "owner",
       "spend_cents": 0, "overall_spend_cents": 4000,
       "monthly_limit_dollars": 100, "hard_limit_override_dollars": 250, "effective_per_user_limit_dollars": 250},
      {"email": "carol@example.com", "name": "Carol",
       "spend_cents": 1234.5, "overall_spend_cents": 1234.5,
       "monthly_limit_dollars": null, "hard_limit_override_dollars": null, "effective_per_user_limit_dollars": null}
    ]'::jsonb) = 'updated');

SELECT pg_temp.check('025: team on-demand is the sum of member spend_cents, overall kept apart',
    (SELECT team_spend_cents = 3684.5 AND team_overall_spend_cents = 14684.5 AND member_count = 3
            AND first_captured_at = '2026-10-20T01:05:00Z' AND captured_at = '2026-11-19T00:05:00Z'
       FROM cursor_spend_cycles WHERE cycle_start = '2026-10-19T00:00:00Z'));
SELECT pg_temp.check('025: limits, overall and cycle fields are persisted per member (email lower-cased)',
    (SELECT spend_cents = 0 AND overall_spend_cents = 4000 AND monthly_limit_dollars = 100
            AND hard_limit_override_dollars = 250 AND effective_per_user_limit_dollars = 250 AND role = 'owner'
       FROM cursor_member_cycle_spend
      WHERE cycle_start = '2026-10-19T00:00:00Z' AND member_email = 'bob@example.com')
    AND (SELECT spend_cents = 2450 AND cursor_user_id = '101'
           FROM cursor_member_cycle_spend
          WHERE cycle_start = '2026-10-19T00:00:00Z' AND member_email = 'alice@example.com')
    AND (SELECT effective_per_user_limit_dollars IS NULL
           FROM cursor_member_cycle_spend
          WHERE cycle_start = '2026-10-19T00:00:00Z' AND member_email = 'carol@example.com'));

-- ---------------------------------------------------------------------------
-- Rollover to Nov 19: Oct 19 is preserved and immutable
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE oct_final AS
SELECT c.team_spend_cents, c.captured_at,
       (SELECT string_agg(member_email || ':' || spend_cents::text, ',' ORDER BY member_email)
          FROM cursor_member_cycle_spend m WHERE m.cycle_start = c.cycle_start) AS members
  FROM cursor_spend_cycles c WHERE c.cycle_start = '2026-10-19T00:00:00Z';

SELECT pg_temp.check('025: the Nov 19 cycle starts a new snapshot',
    record_cursor_spend_snapshot('2026-11-19T00:00:00Z', '2026-11-19T01:05:00Z', 'team-1', '[
      {"email": "alice@example.com", "spend_cents": 50, "overall_spend_cents": 50, "effective_per_user_limit_dollars": 100}
    ]'::jsonb) = 'inserted');
SELECT pg_temp.check('025: a stale Oct 19 snapshot after the reset is refused and writes nothing',
    record_cursor_spend_snapshot('2026-10-19T00:00:00Z', '2026-11-19T02:05:00Z', 'team-1', '[
      {"email": "alice@example.com", "spend_cents": 999999}
    ]'::jsonb) = 'stale');
SELECT pg_temp.check('025: Oct 19 keeps its final snapshot after the rollover',
    (SELECT team_spend_cents = 3684.5 AND captured_at = '2026-11-19T00:05:00Z'
            AND (SELECT string_agg(member_email || ':' || spend_cents::text, ',' ORDER BY member_email)
                   FROM cursor_member_cycle_spend m WHERE m.cycle_start = c.cycle_start) = (SELECT members FROM oct_final)
       FROM cursor_spend_cycles c WHERE c.cycle_start = '2026-10-19T00:00:00Z'));
SELECT pg_temp.check('025: Nov 19 total is its own members only',
    (SELECT team_spend_cents = 50 AND member_count = 1 FROM cursor_spend_cycles WHERE cycle_start = '2026-11-19T00:00:00Z'));

SELECT pg_temp.check('025: a prior cycle''s member rows cannot be updated',
    pg_temp.raises($$UPDATE cursor_member_cycle_spend SET spend_cents = 1 WHERE cycle_start = '2026-10-19T00:00:00Z'$$));
SELECT pg_temp.check('025: a prior cycle''s member rows cannot be deleted',
    pg_temp.raises($$DELETE FROM cursor_member_cycle_spend WHERE cycle_start = '2026-10-19T00:00:00Z'$$));
SELECT pg_temp.check('025: a prior cycle row cannot be updated or deleted',
    pg_temp.raises($$UPDATE cursor_spend_cycles SET team_spend_cents = 1 WHERE cycle_start = '2026-10-19T00:00:00Z'$$)
    AND pg_temp.raises($$DELETE FROM cursor_spend_cycles WHERE cycle_start = '2026-10-19T00:00:00Z'$$));
SELECT pg_temp.check('025: no member row can be added to a prior cycle',
    pg_temp.raises($$INSERT INTO cursor_member_cycle_spend (cycle_start, member_email, spend_cents)
                     VALUES ('2026-10-19T00:00:00Z', 'zed@example.com', 1)$$));
SELECT pg_temp.check('025: Oct 19 unchanged after the refused writes',
    (SELECT team_spend_cents = 3684.5 FROM cursor_spend_cycles WHERE cycle_start = '2026-10-19T00:00:00Z')
    AND (SELECT count(*) FROM cursor_member_cycle_spend WHERE cycle_start = '2026-10-19T00:00:00Z') = 3);

SELECT pg_temp.check('025: cost_records unchanged by cycle snapshots',
    (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot)
    AND (SELECT sum(cost_usd) FROM cost_records) IS NOT DISTINCT FROM (SELECT s FROM before_snapshot));
