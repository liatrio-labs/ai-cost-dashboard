/**
 * GET /api/admin/org/cursor-seats — Cursor seat types and rates (migration 026).
 *   -> CursorSeatState: { available, notice, currentMonth, cycle, cycleInProgress, rates, rateHistory,
 *      current: { person_id: seat_type }, assignmentCount, summary, recurringConflict }
 *   available is false (with a notice) while 026 isn't applied.
 *
 * Writes: ./assign (seat type per person), ./rates (monthly rate per type),
 * ./import (roster CSV backfill). Each applies from a 20th-to-20th billing
 * cycle onward (lib/cursor-seats.ts), never to a past cycle.
 */

import { adminRoute, json } from "@/lib/org/admin/http"
import { loadCursorSeatState } from "@/lib/cursor-seats-admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => json(await loadCursorSeatState(admin)))
