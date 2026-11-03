-- ============================================================================
-- Migration 014: Security hardening (Supabase security advisor, issue #17)
-- ----------------------------------------------------------------------------
-- Closes the advisor findings that are fixable in SQL. Every statement removes
-- or narrows access; nothing is dropped or truncated.
--
--   1. providers: RLS on, authenticated SELECT only (writes are service role).
--   2. app_settings: RLS on, no anon/authenticated policies (service role only).
--   3. cost_records partitions: RLS on, no policies, no anon/authenticated
--      grants, so they can't be read or written directly through the API.
--      Access through the parent keeps the parent's policies (Postgres checks
--      the parent's privileges and RLS, not the partition's). New partitions
--      from create_monthly_partition() get the same treatment.
--   4. search_path pinned on the five functions the advisor flagged (and on
--      initialize_user_preferences, so pg_temp is searched last).
--   5. get_user_total_spend / get_top_models_by_spend: SECURITY INVOKER (they
--      now respect cost_records RLS), no EXECUTE for PUBLIC/anon.
--      initialize_user_preferences: stays SECURITY DEFINER (the signup trigger
--      needs it), no EXECUTE for PUBLIC/anon/authenticated. Triggers don't
--      check EXECUTE, so signup is unaffected.
--   6. refresh_cost_records_daily / create_monthly_partition: service role and
--      owner only.
--   7. cost_records_daily(_attributed): no anon/PUBLIC access. authenticated
--      keeps SELECT (shared org-wide read, migrations 003 and 010).
--
-- Re-running 010 or 011 recreates refresh_cost_records_daily() without its
-- search_path and recreates cost_records_daily_attributed, so re-apply this
-- migration after them.
--
-- Not covered here: leaked password protection is a Supabase Auth dashboard
-- toggle (Authentication > Settings).
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. providers
-- ----------------------------------------------------------------------------
ALTER TABLE public.providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can view providers" ON public.providers;
CREATE POLICY "Authenticated can view providers"
    ON public.providers FOR SELECT
    TO authenticated
    USING (true);

REVOKE ALL ON public.providers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.providers TO authenticated;
GRANT ALL ON public.providers TO service_role;

-- ----------------------------------------------------------------------------
-- 2. app_settings (service role only)
-- ----------------------------------------------------------------------------
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.app_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.app_settings TO service_role;

-- ----------------------------------------------------------------------------
-- 3. cost_records partitions (every level under the parent)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    part REGCLASS;
BEGIN
    FOR part IN
        WITH RECURSIVE tree AS (
            SELECT inhrelid FROM pg_inherits
            WHERE inhparent = 'public.cost_records'::regclass
            UNION ALL
            SELECT i.inhrelid FROM pg_inherits i JOIN tree t ON i.inhparent = t.inhrelid
        )
        SELECT inhrelid::regclass FROM tree
    LOOP
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', part);
        EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated', part);
    END LOOP;
END $$;

-- New partitions: same body as 001, plus RLS and grants, pinned search_path
-- and a schema-qualified parent.
CREATE OR REPLACE FUNCTION public.create_monthly_partition(
    p_year INTEGER,
    p_month INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    partition_name TEXT;
    start_date TEXT;
    end_date TEXT;
BEGIN
    -- Generate partition name and date ranges
    partition_name := format('cost_records_%s_%s', p_year, LPAD(p_month::TEXT, 2, '0'));
    start_date := format('%s-%s-01', p_year, LPAD(p_month::TEXT, 2, '0'));

    -- Calculate end date (first day of next month)
    IF p_month = 12 THEN
        end_date := format('%s-01-01', p_year + 1);
    ELSE
        end_date := format('%s-%s-01', p_year, LPAD((p_month + 1)::TEXT, 2, '0'));
    END IF;

    -- Create partition
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.cost_records FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        start_date,
        end_date
    );

    -- Not reachable directly through the API; access goes through the parent.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', partition_name);

    RAISE NOTICE 'Created partition % for date range % to %', partition_name, start_date, end_date;
END;
$$;

COMMENT ON FUNCTION public.create_monthly_partition(INTEGER, INTEGER) IS
    'Creates a new monthly partition for cost_records (RLS on, no direct API access)';

-- ----------------------------------------------------------------------------
-- 4. Pinned search_path (no body changes)
-- ----------------------------------------------------------------------------
ALTER FUNCTION public.update_updated_at_column() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_total_spend(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
    SET search_path = public, pg_temp;
ALTER FUNCTION public.get_top_models_by_spend(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
    SET search_path = public, pg_temp;
ALTER FUNCTION public.refresh_cost_records_daily() SET search_path = public, pg_temp;
ALTER FUNCTION public.initialize_user_preferences() SET search_path = public, pg_temp;

-- ----------------------------------------------------------------------------
-- 5. SECURITY DEFINER RPCs
-- ----------------------------------------------------------------------------
ALTER FUNCTION public.get_user_total_spend(UUID, TIMESTAMPTZ, TIMESTAMPTZ) SECURITY INVOKER;
ALTER FUNCTION public.get_top_models_by_spend(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.get_user_total_spend(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_top_models_by_spend(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_total_spend(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_top_models_by_spend(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO authenticated, service_role;

-- Trigger-only. Stays SECURITY DEFINER (004) so signup can insert into
-- user_preferences; trigger execution does not need EXECUTE.
REVOKE EXECUTE ON FUNCTION public.initialize_user_preferences() FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. Service-only functions
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.refresh_cost_records_daily() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_monthly_partition(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_cost_records_daily() TO service_role;
GRANT EXECUTE ON FUNCTION public.create_monthly_partition(INTEGER, INTEGER) TO service_role;

-- ----------------------------------------------------------------------------
-- 7. Materialized views (not covered by RLS): authenticated read only
-- ----------------------------------------------------------------------------
REVOKE ALL ON public.cost_records_daily, public.cost_records_daily_attributed FROM PUBLIC, anon;
GRANT SELECT ON public.cost_records_daily, public.cost_records_daily_attributed TO authenticated, service_role;
