/**
 * POST /api/admin/org/cursor-seats/assign
 *   { person_ids: string[] | person_id: string, seat_type: "standard"|"premium"|"free"|"none", from_month?: "YYYY-MM" }
 *   Sets the seat type from from_month (default: the current month) onward.
 *   Earlier months keep their type. -> CursorSeatState after the change.
 *
 * Errors: 400 bad input (unknown person, seat type, or a past month), 503
 * migration 026 not applied.
 */

import { adminRoute, HttpError, json, readJson } from "@/lib/org/admin/http"
import { loadCursorSeatState, setSeatAssignments } from "@/lib/cursor-seats-admin"
import { parseSeatAssignInput, SeatInputError } from "@/lib/cursor-seats"
import { currentMonthOf } from "@/lib/recurring-costs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin, user) => {
  const people = await admin.from("people").select("id")
  if (people.error) throw new HttpError(500, people.error.message)
  const known = new Set(((people.data || []) as { id: string }[]).map((p) => p.id))
  let input
  try {
    input = parseSeatAssignInput(await readJson(request), known, currentMonthOf(new Date()))
  } catch (e) {
    if (e instanceof SeatInputError) throw new HttpError(400, e.message)
    throw e
  }
  await setSeatAssignments(
    admin,
    input.person_ids.map((person_id) => ({ person_id, seat_type: input.seat_type })),
    input.from_month,
    "admin",
    user.email
  )
  return json(await loadCursorSeatState(admin))
})
