-- Assertions for 016 (issue #26): Claude Ultra rename and per-person seat
-- splits through replace_seat_group(). Runs after assertions.sql and
-- assertions_015.sql, with 016 applied twice over the fixtures. Adds its own
-- claude-max cost rows shaped like production's (one manual_entry per month,
-- model 'seats', request_count = seats, $200/seat, 12:00 UTC on the 1st;
-- $15,600 across 2026-03/04/05/06/08), checks, then removes them.
-- Any failure raises (ON_ERROR_STOP).

CREATE FUNCTION pg_temp.check(label TEXT, ok BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL: %', label;
    END IF;
    RAISE NOTICE 'PASS: %', label;
END $$;

-- Sum of claude-max spend, optionally for one month.
CREATE FUNCTION pg_temp.seat_sum(p_month TEXT DEFAULT NULL) RETURNS NUMERIC
LANGUAGE sql AS $$
    SELECT COALESCE(sum(cr.cost_usd), 0) FROM cost_records cr JOIN providers p ON p.id = cr.provider_id
     WHERE p.name = 'claude-max' AND (p_month IS NULL OR cr.metadata ->> 'month' = p_month)
$$;
CREATE FUNCTION pg_temp.seat_ids(p_month TEXT) RETURNS UUID[]
LANGUAGE sql AS $$
    SELECT array_agg(cr.id) FROM cost_records cr JOIN providers p ON p.id = cr.provider_id
     WHERE p.name = 'claude-max' AND cr.metadata ->> 'month' = p_month
$$;
-- Replacement rows for a month: (email or NULL for the remainder, seats, cost).
CREATE FUNCTION pg_temp.split_rows(p_month TEXT, p_group TEXT, p_parts JSONB) RETURNS JSONB
LANGUAGE sql AS $$
    SELECT jsonb_agg(jsonb_build_object(
        'user_id', '00000000-0000-0000-0000-000000000001',
        'provider_id', (SELECT id FROM providers WHERE name = 'claude-max'),
        'timestamp', p_month || '-01T12:00:00Z',
        'model_name', 'seats',
        'cost_usd', (part ->> 2)::numeric,
        'request_count', (part ->> 1)::int,
        'metadata', jsonb_build_object(
            'entry_type', 'monthly_seats', 'month', p_month, 'seats', (part ->> 1)::int,
            'price_per_seat', 200, 'cost_basis', 'seat_subscription', 'notes', 'Ramp cards',
            'seat_group_id', p_group)
          || CASE WHEN part ->> 0 IS NULL
                  THEN jsonb_build_object('remainder', true, 'attribution', jsonb_build_object('granularity', 'org'))
                  ELSE jsonb_build_object('attribution', jsonb_build_object('granularity', 'person', 'person_email', part ->> 0))
             END))
    FROM jsonb_array_elements(p_parts) part
$$;

-- ---------------------------------------------------------------------------
-- Rename and access
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('016: claude-max is displayed as Claude Ultra, slug unchanged',
    (SELECT display_name FROM providers WHERE name = 'claude-max') = 'Claude Ultra'
    AND (SELECT count(*) FROM providers WHERE name = 'claude-max') = 1
    AND NOT EXISTS (SELECT 1 FROM providers WHERE display_name = 'Claude Max'));
SELECT pg_temp.check('016: replace_seat_group is executable by service_role only',
    has_function_privilege('service_role', 'public.replace_seat_group(uuid[], jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.replace_seat_group(uuid[], jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.replace_seat_group(uuid[], jsonb)', 'EXECUTE')
    AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                     WHERE a.grantee = 0 AND p.oid = 'public.replace_seat_group(uuid[], jsonb)'::regprocedure));
SELECT pg_temp.check('016: replace_seat_group pins search_path and is SECURITY INVOKER',
    (SELECT 'search_path=public, pg_temp' = ANY (proconfig) AND NOT prosecdef
       FROM pg_proc WHERE oid = 'public.replace_seat_group(uuid[], jsonb)'::regprocedure));

-- ---------------------------------------------------------------------------
-- Production-shaped seat rows
-- ---------------------------------------------------------------------------
INSERT INTO cost_records (user_id, provider_id, timestamp, model_name, cost_usd,
                          request_count, collection_method, metadata)
SELECT '00000000-0000-0000-0000-000000000001', p.id, (m || '-01T12:00:00Z')::timestamptz, 'seats',
       s * 200, s, 'manual_entry',
       jsonb_build_object('entry_type', 'monthly_seats', 'month', m, 'seats', s, 'price_per_seat', 200,
                          'cost_basis', 'seat_subscription', 'notes', 'Ramp cards')
FROM providers p,
     (VALUES ('2026-03', 12), ('2026-04', 14), ('2026-05', 16), ('2026-06', 18), ('2026-08', 18)) v(m, s)
WHERE p.name = 'claude-max';

SELECT pg_temp.check('016: fixture seat rows total $15,600 across five months',
    pg_temp.seat_sum() = 15600);

CREATE TEMP TABLE before_snapshot AS SELECT count(*) AS n, sum(cost_usd) AS s FROM cost_records;
CREATE TEMP TABLE untouched AS
SELECT cr.id, cr.cost_usd, cr.metadata FROM cost_records cr JOIN providers p ON p.id = cr.provider_id
 WHERE p.name = 'claude-max' AND cr.metadata ->> 'month' <> '2026-04';

-- ---------------------------------------------------------------------------
-- Split 2026-04 ($2,800, 14 seats): alice 1, bob 2, carol 1 at $150, remainder 10
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('016: split inserts one row per person plus the remainder',
    replace_seat_group(pg_temp.seat_ids('2026-04'), pg_temp.split_rows('2026-04', 'sg-april',
        '[["alice@liatrio.com",1,200],["bob@liatrio.com",2,400],["carol@liatrio.com",1,150],[null,10,2050]]')) = 4);
SELECT pg_temp.check('016: the split month still sums to its original total',
    pg_temp.seat_sum('2026-04') = 2800 AND pg_temp.seat_sum() = 15600
    AND (SELECT count(*) FROM cost_records WHERE metadata ->> 'seat_group_id' = 'sg-april') = 4
    AND (SELECT count(*) FROM cost_records WHERE metadata ->> 'seat_group_id' = 'sg-april'
            AND collection_method = 'manual_entry') = 4);
SELECT pg_temp.check('016: un-split months are unchanged',
    NOT EXISTS (SELECT 1 FROM untouched u LEFT JOIN cost_records cr ON cr.id = u.id
                 WHERE cr.id IS NULL OR cr.cost_usd <> u.cost_usd OR cr.metadata <> u.metadata)
    AND (SELECT count(*) FROM untouched) = 4);
SELECT pg_temp.check('016: total cost_records sum unchanged by the split',
    (SELECT sum(cost_usd) FROM cost_records) = (SELECT s FROM before_snapshot)
    AND (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot) + 3);

SELECT refresh_cost_records_daily();
SELECT pg_temp.check('016: assigned seats resolve to the person and their current team',
    (SELECT sum(a.total_cost_usd) FROM cost_records_daily_attributed a
       JOIN people pe ON pe.id = a.person_id
      WHERE a.provider_id = (SELECT id FROM providers WHERE name = 'claude-max')
        AND pe.email = 'alice@liatrio.com' AND a.team_id IS NOT DISTINCT FROM pe.team_id
        AND a.granularity = 'person') = 200
    AND (SELECT sum(a.total_cost_usd) FROM cost_records_daily_attributed a
          WHERE a.provider_id = (SELECT id FROM providers WHERE name = 'claude-max')
            AND a.person_id = 'a0000000-0000-0000-0000-00000000000b'
            AND a.team_id = '70000000-0000-0000-0000-000000000003'
            AND a.department_id = 'd0000000-0000-0000-0000-000000000002') = 400
    AND (SELECT sum(a.total_cost_usd) FROM cost_records_daily_attributed a
          WHERE a.provider_id = (SELECT id FROM providers WHERE name = 'claude-max')
            AND a.person_id = 'a0000000-0000-0000-0000-00000000000c' AND a.team_id IS NULL) = 150);
SELECT pg_temp.check('016: unassigned seats and un-split months stay Unassigned (org), counted once',
    (SELECT sum(a.total_cost_usd) FROM cost_records_daily_attributed a
      WHERE a.provider_id = (SELECT id FROM providers WHERE name = 'claude-max')
        AND a.person_id IS NULL AND a.team_id IS NULL AND a.granularity = 'org') = 2050 + 12800
    AND (SELECT sum(a.total_cost_usd) FROM cost_records_daily_attributed a
          WHERE a.provider_id = (SELECT id FROM providers WHERE name = 'claude-max')) = 15600
    AND (SELECT sum(total_cost_usd) FROM cost_records_daily
          WHERE provider_id = (SELECT id FROM providers WHERE name = 'claude-max')) = 15600);

-- ---------------------------------------------------------------------------
-- Re-assign 2026-04: dave 3 seats, remainder 11. Replaces the whole set.
-- ---------------------------------------------------------------------------
-- (Checks run in a later statement: a statement does not see its own
-- function's writes in its subqueries.)
SELECT pg_temp.check('016: re-assigning inserts the new set',
    replace_seat_group(pg_temp.seat_ids('2026-04'), pg_temp.split_rows('2026-04', 'sg-april',
        '[["dave@liatrio.com",3,600],[null,11,2200]]')) = 2);
SELECT pg_temp.check('016: re-assigning replaced the old set and kept the total',
    (SELECT count(*) FROM cost_records WHERE metadata ->> 'month' = '2026-04'
            AND provider_id = (SELECT id FROM providers WHERE name = 'claude-max')) = 2
    AND NOT EXISTS (SELECT 1 FROM cost_records WHERE metadata -> 'attribution' ->> 'person_email' = 'alice@liatrio.com'
                       AND provider_id = (SELECT id FROM providers WHERE name = 'claude-max'))
    AND pg_temp.seat_sum('2026-04') = 2800 AND pg_temp.seat_sum() = 15600);

-- ---------------------------------------------------------------------------
-- Refusals: each leaves the data as it was
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE april_ids AS SELECT unnest(pg_temp.seat_ids('2026-04')) AS id;
DO $$
DECLARE
    cases TEXT[][] := ARRAY[
        ['sum mismatch', 'mismatch'],
        ['stale id', 'stale'],
        ['api row', 'api'],
        ['other provider', 'provider'],
        ['negative cost', 'negative'],
        ['empty rows', 'empty']];
    c TEXT[];
    ids UUID[];
    rows JSONB;
    ok BOOLEAN;
BEGIN
    FOREACH c SLICE 1 IN ARRAY cases LOOP
        ids := pg_temp.seat_ids('2026-04');
        rows := pg_temp.split_rows('2026-04', 'sg-april', '[["dave@liatrio.com",3,600],[null,11,2200]]');
        IF c[2] = 'mismatch' THEN
            rows := pg_temp.split_rows('2026-04', 'sg-april', '[["dave@liatrio.com",3,600],[null,11,2200.01]]');
        ELSIF c[2] = 'stale' THEN
            ids := ids || uuid_generate_v4();
        ELSIF c[2] = 'api' THEN
            ids := ids || (SELECT id FROM cost_records WHERE collection_method = 'api_automated' LIMIT 1);
        ELSIF c[2] = 'provider' THEN
            rows := jsonb_set(rows, '{0,provider_id}', to_jsonb((SELECT id FROM providers WHERE name = 'openai')));
        ELSIF c[2] = 'negative' THEN
            rows := pg_temp.split_rows('2026-04', 'sg-april', '[["dave@liatrio.com",3,3000],[null,11,-200]]');
        ELSIF c[2] = 'empty' THEN
            rows := '[]'::jsonb;
        END IF;
        ok := false;
        BEGIN
            PERFORM replace_seat_group(ids, rows);
        EXCEPTION WHEN raise_exception THEN
            ok := true;
        END;
        IF NOT ok THEN
            RAISE EXCEPTION 'FAIL: 016: replace_seat_group accepted a bad call (%)', c[1];
        END IF;
        RAISE NOTICE 'PASS: 016: replace_seat_group refuses a bad call (%)', c[1];
    END LOOP;
END $$;
SELECT pg_temp.check('016: refused calls changed nothing',
    (SELECT count(*) FROM april_ids) = 2
    AND NOT EXISTS (SELECT 1 FROM april_ids a LEFT JOIN cost_records cr ON cr.id = a.id WHERE cr.id IS NULL)
    AND pg_temp.seat_sum() = 15600
    AND (SELECT sum(cost_usd) FROM cost_records) = (SELECT s FROM before_snapshot));

SET ROLE authenticated;
DO $$
BEGIN
    PERFORM replace_seat_group('{00000000-0000-0000-0000-000000000099}'::uuid[], '[]'::jsonb);
    RAISE EXCEPTION 'FAIL: 016: authenticated executed replace_seat_group';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: 016: authenticated cannot execute replace_seat_group';
END $$;
RESET ROLE;

-- Leave the shared fixtures as they were for the script's final re-apply.
DELETE FROM cost_records WHERE provider_id = (SELECT id FROM providers WHERE name = 'claude-max');
SELECT refresh_cost_records_daily();
