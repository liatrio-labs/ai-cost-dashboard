/**
 * POST /api/admin/org/people/merge (issue #51)
 *   { primary_id, secondary_id, preview?: boolean }
 *
 * preview: true -> { migration021, preview: MergePreview } with the counts
 *   merge_people() would move (identities, owned keys, seat rows, aliases)
 *   and the primary as it will look. Works without migration 021.
 * otherwise -> { migration021: true, result: MergeResult } after running
 *   merge_people() (migration 021) and refreshing the rollups. Idempotent: a
 *   pair that was already merged returns { result: { already_merged: true,
 *   ...the original counts } } and changes nothing (also for a preview).
 *
 * Errors: 400 same id twice / malformed body; 404 unknown person; 409
 * secondary already merged into someone else, or migration 021 not applied
 * ({ migration021: false, error }). Admin only (adminRoute).
 */

import { adminRoute, HttpError, json, parseBody } from "@/lib/org/admin/http"
import { findMergeLog, has021, loadSeatRows, logAsResult, runMerge } from "@/lib/org/admin/merge"
import { loadOrg, refreshRollups } from "@/lib/org/admin/repo"
import { personMergeSchema } from "@/lib/org/admin/schemas"
import { MergePlanError, MIGRATION_021_MESSAGE, planPersonMerge } from "@/lib/org/person-merge"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin) => {
  const body = await parseBody(request, personMergeSchema)
  const [org, migration021] = await Promise.all([loadOrg(admin), has021(admin)])

  // Already merged (the secondary is gone): report the logged merge, change nothing.
  if (!org.people.some((p) => p.id === body.secondary_id)) {
    const log = migration021 ? await findMergeLog(admin, body.secondary_id) : null
    if (!log) throw new HttpError(404, "Secondary person not found")
    if (log.primary_person_id !== body.primary_id) {
      throw new HttpError(409, `${log.secondary_email} was already merged into another person`)
    }
    return json({ migration021, result: logAsResult(log) })
  }

  let preview
  try {
    preview = planPersonMerge(org, await loadSeatRows(admin), body.primary_id, body.secondary_id)
  } catch (e) {
    if (e instanceof MergePlanError) throw new HttpError(e.status, e.message)
    throw e
  }
  if (body.preview) return json({ migration021, ...(migration021 ? {} : { message: MIGRATION_021_MESSAGE }), preview })

  if (!migration021) throw new HttpError(409, MIGRATION_021_MESSAGE, { migration021: false })
  const call = await runMerge(admin, body.primary_id, body.secondary_id, null)
  if (!call.ok) {
    if (call.missing021) throw new HttpError(409, MIGRATION_021_MESSAGE, { migration021: false })
    throw new HttpError(call.status, call.message)
  }
  if (!call.result.already_merged) await refreshRollups()
  return json({ migration021: true, preview, result: call.result })
})
