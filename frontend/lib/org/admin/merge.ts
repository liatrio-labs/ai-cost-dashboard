/**
 * Data access for the duplicate-person merge tool (issue #51). The merge runs
 * in SQL (merge_people(), migration 021); everything here degrades to "021
 * not applied" instead of failing when the table or function is missing.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { DbError, must } from "./http"
import { MANUAL_METHODS, SEAT_ENTRY_TYPE } from "../seat-assignments"
import { isMissing021, parseMergeResult, type MergeResult, type MergeSeatRow } from "../person-merge"

/** True when person_merges exists (migration 021 applied). Other errors throw. */
export async function has021(admin: SupabaseClient): Promise<boolean> {
  const res = await admin.from("person_merges").select("id").limit(1)
  if (!res.error) return true
  if (isMissing021(res.error)) return false
  throw new DbError(res.error.code, res.error.message)
}

export interface MergeLogRow {
  primary_person_id: string
  secondary_person_id: string
  secondary_email: string
  secondary_display_name: string | null
  moved: Record<string, unknown> | null
  merged_at: string
}

/** The person_merges row for a merged-away person, or null (also when 021 isn't applied or the id isn't a uuid). */
export async function findMergeLog(admin: SupabaseClient, secondaryId: string): Promise<MergeLogRow | null> {
  const res = await admin
    .from("person_merges")
    .select("primary_person_id, secondary_person_id, secondary_email, secondary_display_name, moved, merged_at")
    .eq("secondary_person_id", secondaryId)
    .maybeSingle()
  if (res.error) {
    if (isMissing021(res.error) || res.error.code === "22P02") return null
    throw new DbError(res.error.code, res.error.message)
  }
  return (res.data as MergeLogRow | null) ?? null
}

/** A logged merge as merge_people() reports a repeat of it. */
export function logAsResult(log: MergeLogRow): MergeResult {
  return parseMergeResult({
    ...(log.moved ?? {}),
    already_merged: true,
    primary_id: log.primary_person_id,
    secondary_id: log.secondary_person_id,
    secondary_email: log.secondary_email,
    merged_at: log.merged_at,
  })
}

const PAGE = 1000

/** Every manual seat row (issue #26), paged; only id, method and metadata. */
export async function loadSeatRows(admin: SupabaseClient): Promise<MergeSeatRow[]> {
  const out: MergeSeatRow[] = []
  for (let from = 0; ; from += PAGE) {
    const page = must(
      await admin
        .from("cost_records")
        .select("id, collection_method, metadata")
        .in("collection_method", [...MANUAL_METHODS])
        .eq("metadata->>entry_type", SEAT_ENTRY_TYPE)
        .order("id")
        .range(from, from + PAGE - 1)
    ) as MergeSeatRow[]
    out.push(...(page ?? []))
    if (!page || page.length < PAGE) return out
  }
}

export type MergeCall =
  | { ok: true; result: MergeResult }
  | { ok: false; missing021: true }
  | { ok: false; missing021: false; status: 400 | 404 | 409; message: string }

/** Run merge_people(); maps a missing function and the function's own refusals. */
export async function runMerge(admin: SupabaseClient, primaryId: string, secondaryId: string, mergedBy: string | null): Promise<MergeCall> {
  const res = await admin.rpc("merge_people", { p_primary: primaryId, p_secondary: secondaryId, p_merged_by: mergedBy })
  if (!res.error) return { ok: true, result: parseMergeResult(res.data) }
  if (isMissing021(res.error)) return { ok: false, missing021: true }
  const message = res.error.message ?? ""
  if (/^merge_people:/.test(message)) {
    const text = message.replace(/^merge_people:\s*/, "")
    const status = /already merged into another/.test(text) ? 409 : /not found/.test(text) ? 404 : 400
    return { ok: false, missing021: false, status, message: text }
  }
  throw new DbError(res.error.code, message)
}
