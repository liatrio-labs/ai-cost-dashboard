-- ============================================================================
-- Migration 004: Fix "Database error saving new user" on signup
-- ----------------------------------------------------------------------------
-- The on_auth_user_created trigger calls initialize_user_preferences(), which
-- inserts into public.user_preferences. That table has RLS enabled with an
-- INSERT policy requiring auth.uid() = user_id. During signup there is no
-- session yet (auth.uid() is null), and the function ran with the caller's
-- privileges, so the insert was rejected and the whole auth.users insert was
-- rolled back -> "Database error saving new user".
--
-- Fix: run the function as SECURITY DEFINER (owned by postgres, the table
-- owner, which bypasses RLS) with a pinned search_path. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION initialize_user_preferences()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO user_preferences (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$;
