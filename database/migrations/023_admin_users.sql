-- ============================================================================
-- Migration 023: editable admin list (issue #71)
-- ----------------------------------------------------------------------------
-- Admins used to be the env allowlist (ADMIN_EMAILS / DASHBOARD_OWNER_EMAIL)
-- plus everyone under ADMIN_DOMAINS, which defaulted to liatrio.com, so every
-- @liatrio.com account was an admin. The app no longer defaults a domain; an
-- admin is now an env-allowlist email (always admin, managed in the hosting
-- env, not removable in the UI) or a row in this table (managed on /admin).
--
-- This migration adds:
--
--   admin_users: one row per admin added on /admin. email is unique and
--   stored lowercased and trimmed (CHECK); added_by is the adding admin's
--   email; added_at defaults to now(). RLS on with no policies, and no
--   privileges for PUBLIC, anon or authenticated: only service_role (the
--   server-side admin check and /api/admin/admins) reads or writes it.
--
-- No other table or data is touched. The app degrades safely while this
-- migration is not applied: a missing admin_users table means "env allowlist
-- admins only", and the Admins section on /admin shows a "migration 023 not
-- applied" notice with add/remove disabled.
--
-- Idempotent: safe to re-run.
--
-- Rollback (removes every admin added on /admin; env-allowlist admins are
-- unaffected, and the app goes back to env-allowlist admins only):
--   DROP TABLE IF EXISTS public.admin_users;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT NOT NULL,
    added_by TEXT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT admin_users_email_key UNIQUE (email),
    CONSTRAINT admin_users_email_normalized CHECK (email = lower(btrim(email))),
    CONSTRAINT admin_users_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

COMMENT ON TABLE public.admin_users IS
    'Dashboard admins added on /admin (issue #71), in addition to the env allowlist; service_role only';
COMMENT ON COLUMN public.admin_users.email IS 'Lowercased, trimmed sign-in email';
COMMENT ON COLUMN public.admin_users.added_by IS 'Email of the admin who added this row';

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_users FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_users TO service_role;
