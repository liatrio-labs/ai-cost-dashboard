-- ============================================================================
-- Migration 021: merge duplicate person records (issue #51)
-- ----------------------------------------------------------------------------
-- Some people exist twice (same name, or the same email local-part on two
-- domains), which splits their spend. The admin merge tool
-- (/admin/org -> People -> Possible duplicates) folds a secondary record into
-- a primary one. This migration adds:
--
--   1. person_merges: one row per merged-away person (secondary id, email and
--      name, the primary it went into, what moved, when, by whom). It is the
--      audit log and what makes a repeated merge a no-op.
--
--   2. merge_people(p_primary, p_secondary, p_merged_by): in one transaction
--        * person_identities of the secondary -> the primary,
--        * org_api_keys owned by the secondary -> owned by the primary,
--        * manual seat rows (issue #26: collection_method manual_entry /
--          csv_import, metadata.entry_type 'monthly_seats') whose
--          metadata.attribution.person_email is the secondary's email -> the
--          primary's email (only that field changes; cost is untouched),
--        * aliases: one person_identities row per provider mapping the
--          secondary's email to the primary (skipped where that provider
--          already maps the email), so automated rows that carry the old
--          email keep resolving to the primary through the existing
--          (provider, person_email) identity match in
--          cost_records_daily_attributed. No view change.
--        * the primary keeps its own team / name / active flag and adopts the
--          secondary's team or name only where its own is empty; active if
--          either was,
--        * the secondary people row is deleted and logged in person_merges.
--      Returns JSONB with the moved counts. Calling it again for a pair that
--      was already merged changes nothing and returns
--      {"already_merged": true, ...the original counts}. It refuses the same
--      id twice, an unknown primary, and a secondary that was merged into a
--      different person. It does not refresh the rollups; the admin route
--      calls refresh_cost_records_daily() afterwards.
--      SECURITY INVOKER with a pinned search_path; EXECUTE for service_role
--      only (the admin route), none for PUBLIC, anon or authenticated.
--
-- Spend totals never change: no cost_records row is inserted or deleted and
-- no cost_usd changes. Without this migration the app still works; the merge
-- tool lists duplicates and previews a merge but says the merge needs 021.
--
-- Not applied to production without Robert's approval.
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. person_merges (audit log; service role only)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_merges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- No FKs: the secondary is deleted by the merge and the log must outlive
    -- a later delete of the primary.
    primary_person_id UUID NOT NULL,
    secondary_person_id UUID NOT NULL,
    secondary_email VARCHAR(320) NOT NULL,
    secondary_display_name VARCHAR(200),
    moved JSONB NOT NULL DEFAULT '{}'::jsonb,
    merged_by TEXT,
    merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT person_merges_secondary_key UNIQUE (secondary_person_id),
    CONSTRAINT person_merges_distinct CHECK (primary_person_id <> secondary_person_id)
);

CREATE INDEX IF NOT EXISTS person_merges_primary_idx ON person_merges (primary_person_id);

COMMENT ON TABLE person_merges IS
    'Duplicate person records merged away (issue #51): secondary -> primary, with moved counts';

ALTER TABLE person_merges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON person_merges FROM PUBLIC, anon, authenticated;
GRANT ALL ON person_merges TO service_role;

-- ----------------------------------------------------------------------------
-- 2. merge_people()
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_people(
    p_primary UUID,
    p_secondary UUID,
    p_merged_by TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_primary people%ROWTYPE;
    v_secondary people%ROWTYPE;
    v_log person_merges%ROWTYPE;
    v_identities INTEGER;
    v_keys INTEGER;
    v_seats INTEGER;
    v_aliases INTEGER;
    v_team BOOLEAN;
    v_name BOOLEAN;
    v_moved JSONB;
BEGIN
    IF p_primary IS NULL OR p_secondary IS NULL THEN
        RAISE EXCEPTION 'merge_people: primary and secondary are required';
    END IF;
    IF p_primary = p_secondary THEN
        RAISE EXCEPTION 'merge_people: cannot merge a person into themselves';
    END IF;

    -- Lock both rows (in id order, so two merges of the same pair serialize
    -- without deadlocking).
    PERFORM 1 FROM people WHERE id IN (p_primary, p_secondary) ORDER BY id FOR UPDATE;

    SELECT * INTO v_secondary FROM people WHERE id = p_secondary;
    IF NOT FOUND THEN
        SELECT * INTO v_log FROM person_merges WHERE secondary_person_id = p_secondary;
        IF FOUND AND v_log.primary_person_id = p_primary THEN
            RETURN v_log.moved || jsonb_build_object(
                'already_merged', true,
                'primary_id', p_primary,
                'secondary_id', p_secondary,
                'secondary_email', v_log.secondary_email,
                'merged_at', v_log.merged_at);
        ELSIF FOUND THEN
            RAISE EXCEPTION 'merge_people: % was already merged into another person (%)',
                v_log.secondary_email, v_log.primary_person_id;
        END IF;
        RAISE EXCEPTION 'merge_people: secondary person % not found', p_secondary;
    END IF;

    SELECT * INTO v_primary FROM people WHERE id = p_primary;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'merge_people: primary person % not found', p_primary;
    END IF;

    UPDATE person_identities SET person_id = p_primary WHERE person_id = p_secondary;
    GET DIAGNOSTICS v_identities = ROW_COUNT;

    UPDATE org_api_keys SET owner_person_id = p_primary WHERE owner_person_id = p_secondary;
    GET DIAGNOSTICS v_keys = ROW_COUNT;

    UPDATE cost_records
       SET metadata = jsonb_set(metadata, '{attribution,person_email}', to_jsonb(v_primary.email::text))
     WHERE collection_method IN ('manual_entry', 'csv_import')
       AND metadata ->> 'entry_type' = 'monthly_seats'
       AND lower(btrim(metadata -> 'attribution' ->> 'person_email')) = v_secondary.email;
    GET DIAGNOSTICS v_seats = ROW_COUNT;

    INSERT INTO person_identities (person_id, provider_id, external_id)
    SELECT p_primary, pr.id, v_secondary.email FROM providers pr
    ON CONFLICT ON CONSTRAINT person_identities_provider_external_key DO NOTHING;
    GET DIAGNOSTICS v_aliases = ROW_COUNT;

    v_team := v_primary.team_id IS NULL AND v_secondary.team_id IS NOT NULL;
    v_name := NULLIF(btrim(COALESCE(v_primary.display_name, '')), '') IS NULL
              AND NULLIF(btrim(COALESCE(v_secondary.display_name, '')), '') IS NOT NULL;
    UPDATE people
       SET team_id = COALESCE(team_id, v_secondary.team_id),
           display_name = CASE WHEN v_name THEN v_secondary.display_name ELSE display_name END,
           active = active OR v_secondary.active
     WHERE id = p_primary;

    DELETE FROM people WHERE id = p_secondary;

    v_moved := jsonb_build_object(
        'identities_moved', v_identities,
        'keys_moved', v_keys,
        'seat_rows_moved', v_seats,
        'aliases_added', v_aliases,
        'team_adopted', v_team,
        'display_name_adopted', v_name);

    INSERT INTO person_merges (primary_person_id, secondary_person_id, secondary_email,
                               secondary_display_name, moved, merged_by)
    VALUES (p_primary, p_secondary, v_secondary.email, v_secondary.display_name, v_moved, p_merged_by);

    RETURN v_moved || jsonb_build_object(
        'already_merged', false,
        'primary_id', p_primary,
        'secondary_id', p_secondary,
        'secondary_email', v_secondary.email);
END $$;

COMMENT ON FUNCTION public.merge_people(UUID, UUID, TEXT) IS
    'Merge a duplicate person into another (issue #51): identities, key owners, seat rows, email aliases; idempotent';

REVOKE ALL ON FUNCTION public.merge_people(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_people(UUID, UUID, TEXT) TO service_role;
