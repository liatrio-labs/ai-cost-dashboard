/**
 * POST /api/admin/org/cursor-seats/import — roster CSV backfill.
 *   { csv: string, confirm?: boolean, from_month?: "YYYY-MM" }
 *   The CSV has name, email, role, seat_type columns (the committed seed is
 *   database/seeds/cursor-seat-roster-2026-11-05.csv). Rows match people by
 *   email (case-insensitive) when the row has one, else by exact name.
 *   Removed rows are assigned no billed seat. Unmatched rows are reported;
 *   no person is created.
 *   Without confirm: a dry run -> { plan, roster, applied: 0 }.
 *   With confirm: matched rows are written from from_month (default: the
 *   current month) onward -> { plan, roster, applied, state }.
 *
 * Errors: 400 bad CSV / input, 503 migration 026 not applied.
 */

import { adminRoute, HttpError, json, readJson } from "@/lib/org/admin/http"
import { loadCursorSeatState, setSeatAssignments } from "@/lib/cursor-seats-admin"
import {
  parseFromMonth,
  parseRoster,
  planRosterBackfill,
  rosterRowSummary,
  rosterTotal,
  RosterError,
  SeatInputError,
} from "@/lib/cursor-seats"
import { currentMonthOf } from "@/lib/recurring-costs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_CSV_BYTES = 1_000_000

export const POST = adminRoute(async (request, _params, admin, user) => {
  const body = ((await readJson(request)) ?? {}) as Record<string, unknown>
  if (typeof body.csv !== "string" || !body.csv.trim()) throw new HttpError(400, "csv is required")
  if (body.csv.length > MAX_CSV_BYTES) throw new HttpError(400, "The roster CSV is too large")
  let rows, fromMonth
  try {
    rows = parseRoster(body.csv)
    fromMonth = parseFromMonth(body.from_month, currentMonthOf(new Date()))
  } catch (e) {
    if (e instanceof RosterError || e instanceof SeatInputError) throw new HttpError(400, e.message)
    throw e
  }
  const people = await admin.from("people").select("id, email, display_name")
  if (people.error) throw new HttpError(500, people.error.message)
  const plan = planRosterBackfill(rows, (people.data || []) as { id: string; email: string; display_name: string | null }[])
  const state = await loadCursorSeatState(admin)
  if (!state.available) throw new HttpError(503, state.notice ?? "Migration 026 isn't applied")
  const roster = rosterRowSummary(rows, state.rates)
  const report = {
    plan,
    roster,
    matched_total_usd: rosterTotal(plan, state.rates),
    from_month: fromMonth,
  }
  if (body.confirm !== true) return json({ ...report, applied: 0 })
  const applied = await setSeatAssignments(
    admin,
    plan.assignments.map((a) => ({ person_id: a.person_id, seat_type: a.seat_type })),
    fromMonth,
    "roster",
    user.email
  )
  return json({ ...report, applied, state: await loadCursorSeatState(admin) })
})
