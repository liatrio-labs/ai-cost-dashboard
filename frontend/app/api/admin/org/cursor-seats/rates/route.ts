/**
 * POST /api/admin/org/cursor-seats/rates
 *   { seat_type: "standard"|"premium"|"free", monthly_rate_usd: number, from_month?: "YYYY-MM" }
 *   Sets the monthly rate from from_month (default: the current month)
 *   onward; earlier months keep their rate. A price change is an admin edit,
 *   not a code change. -> CursorSeatState after the change.
 *
 * Errors: 400 bad input (or a past month), 503 migration 026 not applied.
 */

import { adminRoute, HttpError, json, readJson } from "@/lib/org/admin/http"
import { loadCursorSeatState, setSeatRate } from "@/lib/cursor-seats-admin"
import { parseSeatRateInput, SeatInputError } from "@/lib/cursor-seats"
import { currentMonthOf } from "@/lib/recurring-costs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin, user) => {
  let input
  try {
    input = parseSeatRateInput(await readJson(request), currentMonthOf(new Date()))
  } catch (e) {
    if (e instanceof SeatInputError) throw new HttpError(400, e.message)
    throw e
  }
  await setSeatRate(admin, input.seat_type, input.from_month, input.monthly_rate_usd, user.email)
  return json(await loadCursorSeatState(admin))
})
