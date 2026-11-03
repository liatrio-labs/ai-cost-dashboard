-- ============================================================================
-- Migration 016: per-person seat assignments for seat-based manual tools
-- (issue #26), and "Claude Max" -> "Claude Ultra"
-- ----------------------------------------------------------------------------
-- No new table and no view change. A month's seat entry for a seat-based
-- manual tool is split into one manual_entry row per assigned person
-- (metadata.attribution = {granularity: 'person', person_email}) plus one
-- remainder row (granularity 'org') for unassigned seats, all sharing
-- metadata.seat_group_id. cost_records_daily_attributed (010/011/015) already
-- resolves person_email to a person and their team. The split is planned in
-- frontend/lib/org/seat-assignments.ts.
--
-- This migration adds:
--
--   1. replace_seat_group(p_delete_ids, p_rows): deletes a month's rows and
--      inserts their replacement in one transaction, so a re-assignment can
--      never leave the month half-written or counted twice. It refuses when
--        * any id is missing, not a manual row, or already gone (stale edit),
--        * the old rows span more than one provider, or a new row names
--          another provider,
--        * a new cost is NULL or negative,
--        * SUM(new cost_usd) <> SUM(old cost_usd) (exact, NUMERIC(12,6)).
--      New rows are always collection_method 'manual_entry'.
--      SECURITY INVOKER with a pinned search_path; EXECUTE for service_role
--      only (the admin route), none for PUBLIC, anon or authenticated.
--
--   2. Display name: the 'claude-max' provider (created through the admin
--      UI, not by a migration) is renamed from 'Claude Max' to
--      'Claude Ultra'. The slug stays 'claude-max' because collectors,
--      filters and URLs key on providers.name. Only a row still named
--      exactly 'Claude Max' changes, so a hand-chosen name is kept; on an
--      install without the provider this is a no-op. cost_records is not
--      touched.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Atomic replace of a month's seat rows
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.replace_seat_group(p_delete_ids UUID[], p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ids UUID[];
    v_found INTEGER;
    v_providers INTEGER;
    v_provider UUID;
    v_old_sum NUMERIC;
    v_new_sum NUMERIC;
    v_bad INTEGER;
    v_inserted INTEGER;
BEGIN
    SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_delete_ids) x WHERE x IS NOT NULL;
    IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
        RAISE EXCEPTION 'replace_seat_group: no rows to replace';
    END IF;
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
        RAISE EXCEPTION 'replace_seat_group: no replacement rows';
    END IF;

    -- Lock the rows being replaced so two edits of one month serialize.
    PERFORM 1 FROM cost_records
     WHERE id = ANY (v_ids) AND collection_method IN ('manual_entry', 'csv_import')
       FOR UPDATE;

    SELECT count(*), count(DISTINCT provider_id), min(provider_id::text)::uuid, COALESCE(sum(cost_usd), 0)
      INTO v_found, v_providers, v_provider, v_old_sum
      FROM cost_records
     WHERE id = ANY (v_ids) AND collection_method IN ('manual_entry', 'csv_import');
    IF v_found <> cardinality(v_ids) THEN
        RAISE EXCEPTION 'replace_seat_group: % of % rows found (changed since loaded, or not manual entries)',
            v_found, cardinality(v_ids);
    END IF;
    IF v_providers <> 1 THEN
        RAISE EXCEPTION 'replace_seat_group: rows span % providers', v_providers;
    END IF;

    SELECT count(*) FILTER (WHERE (r->>'provider_id')::uuid IS DISTINCT FROM v_provider
                               OR (r->>'cost_usd') IS NULL
                               OR (r->>'cost_usd')::numeric < 0),
           COALESCE(sum((r->>'cost_usd')::numeric), 0)
      INTO v_bad, v_new_sum
      FROM jsonb_array_elements(p_rows) r;
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'replace_seat_group: % replacement rows have another provider or a missing/negative cost', v_bad;
    END IF;
    IF round(v_new_sum, 6) <> round(v_old_sum, 6) THEN
        RAISE EXCEPTION 'replace_seat_group: totals do not reconcile (old %, new %)', v_old_sum, v_new_sum;
    END IF;

    DELETE FROM cost_records WHERE id = ANY (v_ids);

    INSERT INTO cost_records (user_id, provider_id, "timestamp", model_name, cost_usd,
                              request_count, collection_method, metadata)
    SELECT x.user_id, x.provider_id, x."timestamp", x.model_name, x.cost_usd,
           x.request_count, 'manual_entry', COALESCE(x.metadata, '{}'::jsonb)
      FROM jsonb_to_recordset(p_rows) AS x(
           user_id UUID, provider_id UUID, "timestamp" TIMESTAMPTZ, model_name VARCHAR(100),
           cost_usd NUMERIC(12, 6), request_count BIGINT, metadata JSONB);
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END $$;

COMMENT ON FUNCTION public.replace_seat_group(UUID[], JSONB) IS
    'Atomically replace a month''s manual seat rows with a per-person split (issue #26); the sum must not change';

REVOKE ALL ON FUNCTION public.replace_seat_group(UUID[], JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_seat_group(UUID[], JSONB) TO service_role;

-- ----------------------------------------------------------------------------
-- 2. Claude Max -> Claude Ultra (display name only; slug unchanged)
-- ----------------------------------------------------------------------------
UPDATE providers
   SET display_name = 'Claude Ultra', updated_at = NOW()
 WHERE name = 'claude-max' AND display_name = 'Claude Max';
