-- Assertions for 024 (issue #75): invoice_overrides.
-- Runs after assertions.sql and the earlier assertions_NNN.sql, with 024
-- applied twice over the fixtures. Removes every invoice_overrides row it
-- adds. Any failure raises (ON_ERROR_STOP).

CREATE FUNCTION pg_temp.check(label TEXT, ok BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL: %', label;
    END IF;
    RAISE NOTICE 'PASS: %', label;
END $$;

CREATE FUNCTION pg_temp.fails_with(sql TEXT, state TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE sql;
    RETURN FALSE;
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE = state;
END $$;

CREATE TEMP TABLE before_snapshot AS
SELECT count(*) AS n, sum(cost_usd) AS s FROM cost_records;

SELECT pg_temp.check('024: invoice_overrides exists, empty, RLS on',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.invoice_overrides'::regclass)
    AND (SELECT count(*) FROM invoice_overrides) = 0);

SELECT pg_temp.check('024: authenticated may only SELECT; anon has nothing',
    has_table_privilege('authenticated', 'public.invoice_overrides', 'SELECT')
    AND NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
         WHERE has_table_privilege('authenticated', 'public.invoice_overrides', p))
    AND NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
         WHERE has_table_privilege('anon', 'public.invoice_overrides', p)));

SELECT pg_temp.check('024: one SELECT policy for authenticated',
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'invoice_overrides') = 1
    AND (SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'invoice_overrides') = 'SELECT');

SELECT pg_temp.check('024: service_role may read and write',
    has_table_privilege('service_role', 'public.invoice_overrides', 'SELECT')
    AND has_table_privilege('service_role', 'public.invoice_overrides', 'INSERT')
    AND has_table_privilege('service_role', 'public.invoice_overrides', 'UPDATE')
    AND has_table_privilege('service_role', 'public.invoice_overrides', 'DELETE'));

INSERT INTO invoice_overrides (provider_id, month, billed_amount_usd, credits_usd, notes, invoice_ids, entered_by)
VALUES ((SELECT id FROM providers ORDER BY name LIMIT 1), '2026-09-01', 123.45, 10, 'test', ARRAY['INV-1'], 'admin@liatrio.com');
SELECT pg_temp.check('024: insert sets entered_at and keeps the row',
    (SELECT entered_at IS NOT NULL AND billed_amount_usd = 123.45 AND invoice_ids = ARRAY['INV-1'] FROM invoice_overrides));

SELECT pg_temp.check('024: one row per provider + month',
    pg_temp.fails_with($$INSERT INTO invoice_overrides (provider_id, month, billed_amount_usd)
        VALUES ((SELECT id FROM providers ORDER BY name LIMIT 1), '2026-09-01', 1)$$, '23505'));
SELECT pg_temp.check('024: month must be the 1st',
    pg_temp.fails_with($$INSERT INTO invoice_overrides (provider_id, month, billed_amount_usd)
        VALUES ((SELECT id FROM providers ORDER BY name LIMIT 1), '2026-08-15', 1)$$, '23514'));
SELECT pg_temp.check('024: billed amount must be >= 0',
    pg_temp.fails_with($$INSERT INTO invoice_overrides (provider_id, month, billed_amount_usd)
        VALUES ((SELECT id FROM providers ORDER BY name LIMIT 1), '2026-07-01', -1)$$, '23514'));
SELECT pg_temp.check('024: credits must be >= 0',
    pg_temp.fails_with($$INSERT INTO invoice_overrides (provider_id, month, billed_amount_usd, credits_usd)
        VALUES ((SELECT id FROM providers ORDER BY name LIMIT 1), '2026-07-01', 1, -1)$$, '23514'));
SELECT pg_temp.check('024: provider must exist',
    pg_temp.fails_with($$INSERT INTO invoice_overrides (provider_id, month, billed_amount_usd)
        VALUES (uuid_generate_v4(), '2026-07-01', 1)$$, '23503'));

DELETE FROM invoice_overrides;
SELECT pg_temp.check('024: cost_records count and sum unchanged',
    (SELECT count(*) FROM cost_records) = (SELECT n FROM before_snapshot)
    AND (SELECT sum(cost_usd) FROM cost_records) IS NOT DISTINCT FROM (SELECT s FROM before_snapshot));
