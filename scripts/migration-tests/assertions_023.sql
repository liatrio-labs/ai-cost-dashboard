-- Assertions for 023 (issue #71): admin_users.
-- Runs after assertions.sql and the earlier assertions_NNN.sql, with 023
-- applied twice over the fixtures. Removes every admin_users row it adds.
-- Any failure raises (ON_ERROR_STOP).

CREATE FUNCTION pg_temp.check(label TEXT, ok BOOLEAN) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL: %', label;
    END IF;
    RAISE NOTICE 'PASS: %', label;
END $$;

-- Raises unless sql fails with the given SQLSTATE.
CREATE FUNCTION pg_temp.fails_with(sql TEXT, state TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE sql;
    RETURN FALSE;
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE = state;
END $$;

SELECT pg_temp.check('023: admin_users exists, empty, RLS on, no policies',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_users'::regclass)
    AND (SELECT count(*) FROM admin_users) = 0
    AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_users'));

SELECT pg_temp.check('023: anon and authenticated have no privileges on admin_users',
    NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) r,
                      unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
         WHERE has_table_privilege(r, 'public.admin_users', p)));

SELECT pg_temp.check('023: service_role may read and write admin_users',
    has_table_privilege('service_role', 'public.admin_users', 'SELECT')
    AND has_table_privilege('service_role', 'public.admin_users', 'INSERT')
    AND has_table_privilege('service_role', 'public.admin_users', 'DELETE'));

INSERT INTO admin_users (email, added_by) VALUES ('new.admin@liatrio.com', 'robert@liatrio.com');
SELECT pg_temp.check('023: insert sets added_at and keeps added_by',
    (SELECT added_at IS NOT NULL AND added_by = 'robert@liatrio.com' FROM admin_users WHERE email = 'new.admin@liatrio.com'));

SELECT pg_temp.check('023: email is unique',
    pg_temp.fails_with($$INSERT INTO admin_users (email) VALUES ('new.admin@liatrio.com')$$, '23505'));
SELECT pg_temp.check('023: email must be stored lowercased',
    pg_temp.fails_with($$INSERT INTO admin_users (email) VALUES ('Other.Admin@liatrio.com')$$, '23514'));
SELECT pg_temp.check('023: email must be trimmed',
    pg_temp.fails_with($$INSERT INTO admin_users (email) VALUES (' other@liatrio.com')$$, '23514'));
SELECT pg_temp.check('023: email must look like an email',
    pg_temp.fails_with($$INSERT INTO admin_users (email) VALUES ('not-an-email')$$, '23514'));

DELETE FROM admin_users WHERE email = 'new.admin@liatrio.com';
SELECT pg_temp.check('023: assertions leave admin_users empty', (SELECT count(*) FROM admin_users) = 0);
