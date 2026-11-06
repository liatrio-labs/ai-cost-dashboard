/**
 * POST /api/admin/org/cursor-seats/assign
 *   { person_ids: string[] | person_id: string, seat_type: "standard"|"premium"|"free"|"none", from_month?: "YYYY-MM" }
 *   Sets the seat type from billing cycle from_month (the month the 20th-to-20th
 *   cycle starts in; default: the cycle billed this calendar month) onward. It
 *   carries into every later cycle until changed again ("none" removes the
 *   seat). Earlier cycles keep their type. -> CursorSeatState after the change.
 *
 * Errors: 400 bad input (unknown person, seat type, or a past cycle), 503
 * migration 026 not applied.
 */

import { adminRoute, HttpError, json, readJson } from "@/lib/org/admin/http"
import { loadCursorSeatState, setSeatAssignments } from "@/lib/cursor-seats-admin"
import { currentSeatCycle, parseSeatAssignInput, SeatInputError } from "@/lib/cursor-seats"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin, user) => {
  const people = await admin.from("people").select("id")
  if (people.error) throw new HttpError(500, people.error.message)
  const known = new Set(((people.data || []) as { id: string }[]).map((p) => p.id))
  let input
  try {
    input = parseSeatAssignInput(await readJson(request), known, currentSeatCycle(new Date()).key)
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
