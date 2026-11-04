-- Assertions for 022 (issue #59): recurring monthly costs.
-- Runs after assertions.sql and the earlier assertions_NNN.sql, with 022
-- applied twice over the fixtures. Uses the claude-max provider from
-- fixtures.sql and removes every recurring_costs row it adds at the end.
-- Any failure raises (ON_ERROR_STOP).

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

CREATE FUNCTION pg_temp.pid() RETURNS UUID LANGUAGE sql AS
$$ SELECT id FROM providers WHERE name = 'claude-max' $$;

-- segments as "start..end:amount" in start order, for compact comparisons
CREATE FUNCTION pg_temp.segments() RETURNS TEXT LANGUAGE sql AS $$
    SELECT COALESCE(string_agg(to_char(start_month, 'YYYY-MM') || '..' ||
                               COALESCE(to_char(end_month, 'YYYY-MM'), 'open') || ':' || monthly_cost_usd::text,
                               ' ' ORDER BY start_month), '')
      FROM recurring_costs WHERE provider_id = pg_temp.pid()
$$;

-- ---------------------------------------------------------------------------
-- Schema and access
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('022: recurring_costs exists, empty, RLS on',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.recurring_costs'::regclass)
    AND (SELECT count(*) FROM recurring_costs) = 0);
SELECT pg_temp.check('022: authenticated may SELECT but not write recurring_costs',
    has_table_privilege('authenticated', 'public.recurring_costs', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.recurring_costs', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.recurring_costs', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.recurring_costs', 'DELETE'));
SELECT pg_temp.check('022: anon has no access to recurring_costs',
    NOT has_table_privilege('anon', 'public.recurring_costs', 'SELECT'));
SELECT pg_temp.check('022: only service_role executes set_recurring_cost',
    has_function_privilege('service_role', 'public.set_recurring_cost(uuid,date,numeric,integer,numeric,date,text,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.set_recurring_cost(uuid,date,numeric,integer,numeric,date,text,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.set_recurring_cost(uuid,date,numeric,integer,numeric,date,text,uuid)', 'EXECUTE'));

-- ---------------------------------------------------------------------------
-- set_recurring_cost: start, change from a month, end
-- ---------------------------------------------------------------------------
SELECT set_recurring_cost(pg_temp.pid(), '2026-06-01', 4000, 20, 200, NULL, 'Ultra seats', NULL);
SELECT pg_temp.check('022: start an open-ended seat cost',
    pg_temp.segments() = '2026-06..open:4000.00');

SELECT set_recurring_cost(pg_temp.pid(), '2026-09-15', 5000, 25, 200, NULL, NULL, NULL);
SELECT pg_temp.check('022: change from September keeps June-August unchanged',
    pg_temp.segments() = '2026-06..2026-08:4000.00 2026-09..open:5000.00');

SELECT set_recurring_cost(pg_temp.pid(), '2026-09-01', 5200, 26, 200, NULL, NULL, NULL);
SELECT pg_temp.check('022: editing from a segment start replaces that segment only',
    pg_temp.segments() = '2026-06..2026-08:4000.00 2026-09..open:5200.00');

SELECT set_recurring_cost(pg_temp.pid(), '2026-12-01', NULL, NULL, NULL, NULL, NULL, NULL);
SELECT pg_temp.check('022: end from December closes the open segment at November',
    pg_temp.segments() = '2026-06..2026-08:4000.00 2026-09..2026-11:5200.00');

SELECT set_recurring_cost(pg_temp.pid(), '2027-02-01', 100, NULL, NULL, '2027-03-01', NULL, NULL);
SELECT pg_temp.check('022: a later bounded flat segment after a gap',
    pg_temp.segments() = '2026-06..2026-08:4000.00 2026-09..2026-11:5200.00 2027-02..2027-03:100.00');

SELECT set_recurring_cost(pg_temp.pid(), '2026-10-01', 4800, 24, 200, NULL, NULL, NULL);
SELECT pg_temp.check('022: change from October drops later segments, keeps earlier months',
    pg_temp.segments() = '2026-06..2026-08:4000.00 2026-09..2026-09:5200.00 2026-10..open:4800.00');

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    c TEXT[];
    ok BOOLEAN;
BEGIN
    FOREACH c SLICE 1 IN ARRAY ARRAY[
        ARRAY['overlapping segment', $q$INSERT INTO recurring_costs (provider_id, start_month, monthly_cost_usd) VALUES (pg_temp.pid(), '2026-07-01', 1)$q$],
        ARRAY['start not on the 1st', $q$INSERT INTO recurring_costs (provider_id, start_month, monthly_cost_usd) VALUES (pg_temp.pid(), '2025-01-15', 1)$q$],
        ARRAY['end before start', $q$INSERT INTO recurring_costs (provider_id, start_month, end_month, monthly_cost_usd) VALUES (pg_temp.pid(), '2025-03-01', '2025-01-01', 1)$q$],
        ARRAY['negative amount', $q$INSERT INTO recurring_costs (provider_id, start_month, end_month, monthly_cost_usd) VALUES (pg_temp.pid(), '2025-01-01', '2025-01-01', -1)$q$],
        ARRAY['seats without price', $q$INSERT INTO recurring_costs (provider_id, start_month, end_month, monthly_cost_usd, seats) VALUES (pg_temp.pid(), '2025-01-01', '2025-01-01', 10, 2)$q$],
        ARRAY['amount <> seats x price', $q$INSERT INTO recurring_costs (provider_id, start_month, end_month, monthly_cost_usd, seats, price_per_seat) VALUES (pg_temp.pid(), '2025-01-01', '2025-01-01', 10, 2, 6)$q$]
    ] LOOP
        ok := false;
        BEGIN
            EXECUTE c[2];
        EXCEPTION WHEN check_violation OR exclusion_violation THEN
            ok := true;
        END;
        IF NOT ok THEN
            RAISE EXCEPTION 'FAIL: 022: accepted a bad segment (%)', c[1];
        END IF;
        RAISE NOTICE 'PASS: 022: refuses a bad segment (%)', c[1];
    END LOOP;
END $$;

SET ROLE authenticated;
DO $$
BEGIN
    PERFORM set_recurring_cost((SELECT id FROM providers WHERE name = 'claude-max'), '2027-01-01', 1, NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL: 022: authenticated executed set_recurring_cost';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: 022: authenticated cannot execute set_recurring_cost';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Nothing in cost_records or the rollups changes
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('022: cost_records count and sum unchanged',
    (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot)
    AND (SELECT sum(cost_usd) FROM cost_records) IS NOT DISTINCT FROM (SELECT s FROM before_snapshot));

-- Deleting the provider removes its segments (ON DELETE CASCADE) is covered by
-- the FK; leave the shared fixtures as they were.
DELETE FROM recurring_costs;
SELECT pg_temp.check('022: cleaned up', (SELECT count(*) FROM recurring_costs) = 0);
