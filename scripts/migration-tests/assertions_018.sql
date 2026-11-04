-- Assertions for 018 (issue #44): provider key creation dates and the
-- needs-review inbox decisions table. Runs after the earlier assertion
-- files, with 018 applied twice over the fixtures. Cleans up after itself.
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
CREATE TEMP TABLE before_attr AS
SELECT date, sum(total_cost_usd) AS c FROM cost_records_daily_attributed GROUP BY date;

-- ---------------------------------------------------------------------------
-- org_api_keys.provider_created_at
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('018: org_api_keys has a nullable timestamptz provider_created_at',
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'org_api_keys'
               AND column_name = 'provider_created_at'
               AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'));
SELECT pg_temp.check('018: existing keys keep NULL provider_created_at (unknown)',
    (SELECT count(*) FROM org_api_keys WHERE provider_created_at IS NOT NULL) = 0);
UPDATE org_api_keys SET provider_created_at = '2026-10-30T08:00:00Z' WHERE external_key_id = 'key_bare';
SELECT pg_temp.check('018: provider_created_at stores a timestamp',
    (SELECT provider_created_at FROM org_api_keys WHERE external_key_id = 'key_bare') = '2026-10-30T08:00:00Z'::timestamptz);

-- ---------------------------------------------------------------------------
-- review_items
-- ---------------------------------------------------------------------------
INSERT INTO review_items (kind, subject, period, amount, status, note, acknowledged_by)
VALUES ('person_spike', 'p-1', '2026-10', 600, 'acknowledged', 'conference demo', 'admin@example.com');
SELECT pg_temp.check('018: review_items stores an acknowledgement with its note',
    (SELECT note FROM review_items WHERE kind = 'person_spike' AND subject = 'p-1' AND period = '2026-10') = 'conference demo'
    AND (SELECT acknowledged_at IS NOT NULL FROM review_items WHERE subject = 'p-1'));

DO $$
BEGIN
    INSERT INTO review_items (kind, subject, period, amount) VALUES ('person_spike', 'p-1', '2026-10', 700);
    RAISE EXCEPTION 'FAIL: duplicate (kind, subject, period) accepted';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: 018: one review_items row per (kind, subject, period)';
END $$;
INSERT INTO review_items (kind, subject, period, amount, note) VALUES ('person_spike', 'p-1', '2026-10', 800, 'again')
ON CONFLICT (kind, subject, period) DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note;
SELECT pg_temp.check('018: upsert on (kind, subject, period) replaces the decision',
    (SELECT amount FROM review_items WHERE subject = 'p-1') = 800 AND (SELECT count(*) FROM review_items WHERE subject = 'p-1') = 1);

DO $$
BEGIN
    INSERT INTO review_items (kind, subject, period) VALUES ('mystery', 'x', '2026-10');
    RAISE EXCEPTION 'FAIL: unknown kind accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 018: kind must be a known item kind';
END $$;
DO $$
BEGIN
    INSERT INTO review_items (kind, subject, period, status) VALUES ('person_day', 'x', '2026-10-01', 'ignored');
    RAISE EXCEPTION 'FAIL: unknown status accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 018: status must be acknowledged or assigned';
END $$;
DO $$
BEGIN
    INSERT INTO review_items (kind, subject, period) VALUES ('person_day', 'x', 'October');
    RAISE EXCEPTION 'FAIL: bad period accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: 018: period must be YYYY-MM or YYYY-MM-DD';
END $$;

-- ---------------------------------------------------------------------------
-- Access: admin-only (service role); anon and authenticated get nothing.
-- ---------------------------------------------------------------------------
SELECT pg_temp.check('018: review_items has RLS enabled',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.review_items'::regclass));
SELECT pg_temp.check('018: anon and authenticated have no privileges on review_items',
    NOT has_table_privilege('anon', 'public.review_items', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.review_items', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.review_items', 'INSERT'));
SELECT pg_temp.check('018: service_role can write review_items',
    has_table_privilege('service_role', 'public.review_items', 'INSERT'));
SET ROLE authenticated;
SELECT pg_temp.check('018: authenticated can still read org_api_keys.provider_created_at',
    (SELECT count(*) FROM org_api_keys WHERE provider_created_at IS NOT NULL) = 1);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Totals unchanged
-- ---------------------------------------------------------------------------
SELECT refresh_cost_records_daily();
SELECT pg_temp.check('018: attributed totals per date unchanged',
    (SELECT count(*) FROM (
        SELECT date, sum(total_cost_usd) AS c FROM cost_records_daily_attributed GROUP BY date
    ) a FULL JOIN before_attr b USING (date) WHERE a.c IS DISTINCT FROM b.c) = 0);

-- Leave the shared fixtures as they were for the script's final re-apply.
DELETE FROM review_items;
UPDATE org_api_keys SET provider_created_at = NULL WHERE external_key_id = 'key_bare';
SELECT pg_temp.check('018: cost_records unchanged',
    (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot)
    AND (SELECT sum(cost_usd) FROM cost_records) IS NOT DISTINCT FROM (SELECT s FROM before_snapshot));
