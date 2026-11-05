-- Assertions for 026: Cursor seat types per person and monthly seat rates.
-- Runs after the earlier assertions, with 026 applied twice over the
-- fixtures. Uses the fixture people (alice, bob, dave) and removes every row
-- it adds at the end (rates go back to the seeded values).
-- Any failure raises (ON_ERROR_STOP).

CREATE FUNCTION pg_temp.check(label TEXT, ok BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL: %', label;
    END IF;
    RAISE NOTICE 'PASS: %', label;
END $$;

CREATE FUNCTION pg_temp.raises(sql TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE sql;
    RETURN false;
EXCEPTION WHEN OTHERS THEN
    RETURN true;
END $$;

CREATE TEMP TABLE before_snapshot AS
SELECT count(*) AS n, sum(cost_usd) AS s FROM cost_records;

-- person's seat type for a month, as the app resolves it (latest effective_month <= month)
CREATE FUNCTION pg_temp.seat(p UUID, m DATE) RETURNS TEXT LANGUAGE sql AS $$
    SELECT COALESCE((SELECT seat_type FROM cursor_seat_assignments
                      WHERE person_id = p AND effective_month <= m
                      ORDER BY effective_month DESC LIMIT 1), 'none')
$$;
CREATE FUNCTION pg_temp.rate(t TEXT, m DATE) RETURNS NUMERIC LANGUAGE sql AS $$
    SELECT monthly_rate_usd FROM cursor_seat_rates
     WHERE seat_type = t AND effective_month <= m
     ORDER BY effective_month DESC LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Schema, seed and access
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('026: tables exist with RLS on; no assignments seeded',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cursor_seat_assignments'::regclass)
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cursor_seat_rates'::regclass)
    AND (SELECT count(*) FROM cursor_seat_assignments) = 0);
SELECT pg_temp.check('026: rates seeded once (applied twice): standard 40, premium 80, free 0',
    (SELECT count(*) FROM cursor_seat_rates) = 3
    AND pg_temp.rate('standard', DATE '2026-11-01') = 40.00
    AND pg_temp.rate('premium', DATE '2026-11-01') = 80.00
    AND pg_temp.rate('free', DATE '2026-11-01') = 0.00);
SELECT pg_temp.check('026: authenticated may SELECT but not write; anon has nothing',
    has_table_privilege('authenticated', 'public.cursor_seat_assignments', 'SELECT')
    AND has_table_privilege('authenticated', 'public.cursor_seat_rates', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.cursor_seat_assignments', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.cursor_seat_rates', 'UPDATE')
    AND NOT has_table_privilege('anon', 'public.cursor_seat_assignments', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.cursor_seat_rates', 'SELECT'));
SELECT pg_temp.check('026: write functions are service_role only, SECURITY INVOKER, pinned search_path',
    has_function_privilege('service_role', 'public.set_cursor_seat_assignments(jsonb, date, text, text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.set_cursor_seat_rate(text, date, numeric, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.set_cursor_seat_assignments(jsonb, date, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.set_cursor_seat_rate(text, date, numeric, text)', 'EXECUTE')
    AND NOT (SELECT bool_or(prosecdef) FROM pg_proc WHERE proname IN ('set_cursor_seat_assignments', 'set_cursor_seat_rate'))
    AND (SELECT bool_and('search_path=public, pg_temp' = ANY (proconfig)) FROM pg_proc
          WHERE proname IN ('set_cursor_seat_assignments', 'set_cursor_seat_rate')));

-- ---------------------------------------------------------------------------
-- Assignments: from a month onward
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE n_written (step TEXT, n INTEGER);
INSERT INTO n_written SELECT 'import', set_cursor_seat_assignments(
    '[{"person_id":"a0000000-0000-0000-0000-00000000000d","seat_type":"premium"},
      {"person_id":"a0000000-0000-0000-0000-00000000000a","seat_type":"standard"},
      {"person_id":"a0000000-0000-0000-0000-00000000000b","seat_type":"free"}]'::jsonb,
    DATE '2026-11-05', 'roster', 'admin@example.com');
SELECT pg_temp.check('026: a roster import sets each person''s type from the month',
    (SELECT n FROM n_written WHERE step = 'import') = 3
    AND pg_temp.seat('a0000000-0000-0000-0000-00000000000d', DATE '2026-11-01') = 'premium'
    AND pg_temp.seat('a0000000-0000-0000-0000-00000000000d', DATE '2026-10-01') = 'none'
    AND (SELECT bool_and(effective_month = DATE '2026-11-01' AND source = 'roster' AND set_by = 'admin@example.com')
           FROM cursor_seat_assignments));

INSERT INTO n_written SELECT 'dec', set_cursor_seat_assignments(
    '[{"person_id":"a0000000-0000-0000-0000-00000000000d","seat_type":"standard"}]'::jsonb, DATE '2026-12-01', 'admin', 'admin@example.com');
SELECT pg_temp.check('026: a later change keeps earlier months',
    (SELECT n FROM n_written WHERE step = 'dec') = 1
    AND pg_temp.seat('a0000000-0000-0000-0000-00000000000d', DATE '2026-11-01') = 'premium'
    AND pg_temp.seat('a0000000-0000-0000-0000-00000000000d', DATE '2026-12-01') = 'standard');

SELECT set_cursor_seat_assignments(
    '[{"person_id":"a0000000-0000-0000-0000-00000000000d","seat_type":"none"}]'::jsonb, DATE '2026-12-01', 'admin', NULL);
SELECT pg_temp.check('026: re-setting a month replaces it',
    pg_temp.seat('a0000000-0000-0000-0000-00000000000d', DATE '2026-12-01') = 'none'
    AND (SELECT count(*) FROM cursor_seat_assignments WHERE person_id = 'a0000000-0000-0000-0000-00000000000d') = 2);

SELECT set_cursor_seat_assignments(
    '[{"person_id":"a0000000-0000-0000-0000-00000000000d","seat_type":"premium"}]'::jsonb, DATE '2026-11-01', 'admin', NULL);
SELECT pg_temp.check('026: setting from an earlier month removes the person''s later rows only',
    (SELECT count(*) FROM cursor_seat_assignments WHERE person_id = 'a0000000-0000-0000-0000-00000000000d') = 1
    AND pg_temp.seat('a0000000-0000-0000-0000-00000000000d', DATE '2027-01-01') = 'premium'
    AND pg_temp.seat('a0000000-0000-0000-0000-00000000000a', DATE '2026-11-01') = 'standard');

SELECT pg_temp.check('026: assignment writes refuse bad input and change nothing',
    pg_temp.raises($q$SELECT set_cursor_seat_assignments('[{"person_id":"a0000000-0000-0000-0000-00000000000d","seat_type":"ultra"}]', DATE '2026-11-01', 'admin', NULL)$q$)
    AND pg_temp.raises($q$SELECT set_cursor_seat_assignments('[{"person_id":"a0000000-0000-0000-0000-0000000000ff","seat_type":"free"}]', DATE '2026-11-01', 'admin', NULL)$q$)
    AND pg_temp.raises($q$SELECT set_cursor_seat_assignments('[{"person_id":"a0000000-0000-0000-0000-00000000000d","seat_type":"free"},{"person_id":"a0000000-0000-0000-0000-00000000000d","seat_type":"premium"}]', DATE '2026-11-01', 'admin', NULL)$q$)
    AND pg_temp.raises($q$SELECT set_cursor_seat_assignments('[]', DATE '2026-11-01', 'admin', NULL)$q$)
    AND pg_temp.raises($q$SELECT set_cursor_seat_assignments('[{"person_id":"a0000000-0000-0000-0000-00000000000d","seat_type":"free"}]', DATE '2026-11-01', 'scraper', NULL)$q$)
    AND pg_temp.raises($q$INSERT INTO cursor_seat_assignments (person_id, effective_month, seat_type) VALUES ('a0000000-0000-0000-0000-00000000000c', DATE '2026-11-15', 'free')$q$)
    AND pg_temp.seat('a0000000-0000-0000-0000-00000000000d', DATE '2026-11-01') = 'premium'
    AND (SELECT count(*) FROM cursor_seat_assignments) = 3);

-- ---------------------------------------------------------------------------
-- Rates: from a month onward
-- ---------------------------------------------------------------------------
SELECT set_cursor_seat_rate('premium', DATE '2026-12-10', 100, 'admin@example.com');
SELECT pg_temp.check('026: a rate change applies from its month; earlier months keep the old rate',
    pg_temp.rate('premium', DATE '2026-11-01') = 80.00
    AND pg_temp.rate('premium', DATE '2026-12-01') = 100.00
    AND (SELECT updated_by FROM cursor_seat_rates WHERE seat_type = 'premium' AND effective_month = DATE '2026-12-01') = 'admin@example.com');
SELECT set_cursor_seat_rate('premium', DATE '2026-12-01', 90.004, NULL);
SELECT pg_temp.check('026: re-setting a month replaces it (rounded to cents)',
    pg_temp.rate('premium', DATE '2026-12-01') = 90.00
    AND (SELECT count(*) FROM cursor_seat_rates WHERE seat_type = 'premium') = 2);
SELECT pg_temp.check('026: rate writes refuse unknown types and negative rates',
    pg_temp.raises($q$SELECT set_cursor_seat_rate('none', DATE '2026-11-01', 1, NULL)$q$)
    AND pg_temp.raises($q$SELECT set_cursor_seat_rate('premium', DATE '2026-11-01', -1, NULL)$q$)
    AND pg_temp.raises($q$SELECT set_cursor_seat_rate('premium', NULL, 1, NULL)$q$));

-- ---------------------------------------------------------------------------
-- Person delete, cost_records untouched, cleanup
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('026: cost_records untouched by seat writes',
    (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot)
    AND (SELECT COALESCE(sum(cost_usd), 0) FROM cost_records) = (SELECT COALESCE(s, 0) FROM before_snapshot));

DELETE FROM cursor_seat_assignments;
DELETE FROM cursor_seat_rates WHERE effective_month <> DATE '2000-01-01';
SELECT pg_temp.check('026: cleanup leaves only the seeded rates',
    (SELECT count(*) FROM cursor_seat_assignments) = 0
    AND (SELECT count(*) FROM cursor_seat_rates) = 3);
