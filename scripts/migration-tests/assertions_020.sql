-- Assertions for 020 (issue #49): monthly budgets and the alert log. Runs
-- after the earlier assertion files, with 020 applied twice over the
-- fixtures. Cleans up after itself. Any failure raises (ON_ERROR_STOP).

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
CREATE TEMP TABLE before_attr AS
SELECT date, sum(total_cost_usd) AS c FROM cost_records_daily_attributed GROUP BY date;

-- ---------------------------------------------------------------------------
-- budgets
-- ---------------------------------------------------------------------------
INSERT INTO budgets (scope, subject_id, monthly_usd, note, created_by)
SELECT 'team', id, 2000, 'Q4 cap', 'admin@example.com' FROM teams ORDER BY name LIMIT 1;
SELECT pg_temp.check('020: budgets stores a team budget',
    (SELECT count(*) FROM budgets WHERE scope = 'team' AND monthly_usd = 2000 AND note = 'Q4 cap') = 1);

DO $$
BEGIN
    INSERT INTO budgets (scope, subject_id, monthly_usd) SELECT scope, subject_id, 3000 FROM budgets LIMIT 1;
    RAISE EXCEPTION 'FAIL: duplicate (scope, subject_id) accepted';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: 020: one budget per (scope, subject_id)';
END $$;
DO $$
BEGIN
    INSERT INTO budgets (scope, subject_id, monthly_usd) VALUES ('department', uuid_generate_v4(), 10);
    RAISE EXCEPTION 'FAIL: unknown scope accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 020: scope must be person, team or project';
END $$;
DO $$
BEGIN
    INSERT INTO budgets (scope, subject_id, monthly_usd) VALUES ('person', uuid_generate_v4(), 0);
    RAISE EXCEPTION 'FAIL: zero budget accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 020: monthly_usd must be > 0';
END $$;

-- ---------------------------------------------------------------------------
-- alert_log: at most once per subject per month (dry-run and live separately)
-- ---------------------------------------------------------------------------
INSERT INTO alert_log (subject, period, kinds, dry_run, amount, budget_usd, message)
VALUES ('team:abc', '2026-11', ARRAY['projected_overrun'], true, 3000, 2000, 'x');
SELECT pg_temp.check('020: alert_log defaults: channels empty, sent_at set',
    (SELECT channels = '{}' AND sent_at IS NOT NULL FROM alert_log WHERE subject = 'team:abc'));
DO $$
BEGIN
    INSERT INTO alert_log (subject, period, kinds, dry_run) VALUES ('team:abc', '2026-11', ARRAY['spike'], true);
    RAISE EXCEPTION 'FAIL: second dry-run alert for the same subject and month accepted';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: 020: one dry-run alert per subject per month';
END $$;
INSERT INTO alert_log (subject, period, kinds, dry_run, channels) VALUES ('team:abc', '2026-11', ARRAY['projected_overrun'], false, ARRAY['slack']);
DO $$
BEGIN
    INSERT INTO alert_log (subject, period, kinds, dry_run) VALUES ('team:abc', '2026-11', ARRAY['spike'], false);
    RAISE EXCEPTION 'FAIL: second live alert for the same subject and month accepted';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: 020: one live alert per subject per month (dry-run logged separately)';
END $$;
INSERT INTO alert_log (subject, period, kinds, dry_run) VALUES ('team:abc', '2026-12', ARRAY['spike'], false);
SELECT pg_temp.check('020: next month alerts again', (SELECT count(*) FROM alert_log WHERE subject = 'team:abc') = 3);
DO $$
BEGIN
    INSERT INTO alert_log (subject, period, kinds) VALUES ('dept:x', '2026-11', ARRAY['spike']);
    RAISE EXCEPTION 'FAIL: bad subject accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 020: subject must be person:/team:/project:';
END $$;
DO $$
BEGIN
    INSERT INTO alert_log (subject, period, kinds) VALUES ('team:x', '2026-11-01', ARRAY['spike']);
    RAISE EXCEPTION 'FAIL: bad period accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 020: period must be YYYY-MM';
END $$;
DO $$
BEGIN
    INSERT INTO alert_log (subject, period, kinds) VALUES ('team:x', '2026-11', ARRAY['mystery']);
    RAISE EXCEPTION 'FAIL: unknown alert kind accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 020: kinds must be projected_overrun / spike';
END $$;

-- ---------------------------------------------------------------------------
-- review_items accepts budget_over (018 is applied before 020 here)
-- ---------------------------------------------------------------------------
INSERT INTO review_items (kind, subject, period, amount) VALUES ('budget_over', 'team:abc', '2026-11', 3000);
SELECT pg_temp.check('020: review_items accepts budget_over',
    (SELECT count(*) FROM review_items WHERE kind = 'budget_over') = 1);
DO $$
BEGIN
    INSERT INTO review_items (kind, subject, period) VALUES ('mystery', 'x', '2026-10');
    RAISE EXCEPTION 'FAIL: unknown kind accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 020: review_items still rejects unknown kinds';
END $$;

-- ---------------------------------------------------------------------------
-- Access: admin-only (service role)
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('020: budgets and alert_log have RLS enabled',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.budgets'::regclass)
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.alert_log'::regclass));
SELECT pg_temp.check('020: anon and authenticated have no privileges on budgets / alert_log',
    NOT has_table_privilege('anon', 'public.budgets', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.budgets', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.budgets', 'INSERT')
    AND NOT has_table_privilege('anon', 'public.alert_log', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.alert_log', 'SELECT'));
SELECT pg_temp.check('020: service_role can write budgets and alert_log',
    has_table_privilege('service_role', 'public.budgets', 'INSERT')
    AND has_table_privilege('service_role', 'public.alert_log', 'INSERT'));

-- ---------------------------------------------------------------------------
-- Totals unchanged
-- ---------------------------------------------------------------------------
SELECT refresh_cost_records_daily();
SELECT pg_temp.check('020: attributed totals per date unchanged',
    (SELECT count(*) FROM (
        SELECT date, sum(total_cost_usd) AS c FROM cost_records_daily_attributed GROUP BY date
    ) a FULL JOIN before_attr b USING (date) WHERE a.c IS DISTINCT FROM b.c) = 0);

DELETE FROM review_items;
DELETE FROM alert_log;
DELETE FROM budgets;
SELECT pg_temp.check('020: cost_records unchanged',
    (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot)
    AND (SELECT sum(cost_usd) FROM cost_records) IS NOT DISTINCT FROM (SELECT s FROM before_snapshot));
