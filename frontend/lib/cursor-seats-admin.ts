/**
 * Server-side reads and writes for Cursor seat types (migration 026).
 * Service-role client only (callers are admin-gated). Writes go through
 * set_cursor_seat_assignments() / set_cursor_seat_rate(), which apply a change
 * from a billing cycle onward (p_from_month = the cycle key YYYY-MM-01, see
 * lib/cursor-seats.ts), so earlier cycles never change. Nothing here touches
 * cost_records.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { HttpError } from "@/lib/org/admin/http"
import {
  CURSOR_SLUG,
  MIGRATION_026_MESSAGE,
  SEAT_ASSIGNMENT_COLUMNS,
  SEAT_RATE_COLUMNS,
  currentSeatCycle,
  isMissingSeatTables,
  ratesAt,
  seatCycleInProgress,
  seatSummary,
  seatTypeFor,
  type AssignableSeatType,
  type SeatAssignment,
  type SeatCycle,
  type SeatRate,
  type SeatSummary,
  type SeatType,
} from "@/lib/cursor-seats"
import { covers, isMissingRelation, RECURRING_COLUMNS, type RecurringCost } from "@/lib/recurring-costs"

export interface CursorSeatState {
  available: boolean
  /** Set when migration 026 isn't applied. */
  notice: string | null
  /**
   * Key (YYYY-MM) of the cycle edits apply from by default: the cycle billed
   * in the current calendar month (currentSeatCycle). Also that month.
   */
  currentMonth: string
  /** That cycle's dates, e.g. Nov 20 – Dec 20, 2026. */
  cycle: SeatCycle
  /** The cycle today falls in (on Nov 6 that is Oct 20 – Nov 20, already billed in October). */
  cycleInProgress: SeatCycle
  /** Rate per seat type for `cycle`. */
  rates: Record<SeatType, number>
  rateHistory: SeatRate[]
  /** person id -> seat type in `cycle` (people with no row are unassigned). */
  current: Record<string, AssignableSeatType>
  assignmentCount: number
  summary: SeatSummary | null
  /** A recurring Cursor cost covers the cycle's month; per-person seats replace it while both exist. */
  recurringConflict: boolean
}

export async function loadCursorSeatState(admin: SupabaseClient, now = new Date()): Promise<CursorSeatState> {
  const cycle = currentSeatCycle(now)
  const currentMonth = cycle.key
  const cycleInProgress = seatCycleInProgress(now)
  const [a, r] = await Promise.all([
    admin.from("cursor_seat_assignments").select(SEAT_ASSIGNMENT_COLUMNS).order("effective_month"),
    admin.from("cursor_seat_rates").select(SEAT_RATE_COLUMNS).order("effective_month"),
  ])
  for (const res of [a, r]) {
    if (res.error) {
      if (isMissingSeatTables(res.error)) {
        return {
          available: false,
          notice: MIGRATION_026_MESSAGE,
          currentMonth,
          cycle,
          cycleInProgress,
          rates: { standard: 0, premium: 0, free: 0 },
          rateHistory: [],
          current: {},
          assignmentCount: 0,
          summary: null,
          recurringConflict: false,
        }
      }
      throw new HttpError(500, res.error.message || "Failed to load Cursor seats")
    }
  }
  const assignments = (a.data || []) as SeatAssignment[]
  const rates = (r.data || []) as SeatRate[]
  const people = await admin.from("people").select("id")
  if (people.error) throw new HttpError(500, people.error.message)
  const ids = ((people.data || []) as { id: string }[]).map((p) => p.id)
  const current: Record<string, AssignableSeatType> = {}
  for (const id of ids) current[id] = seatTypeFor(assignments, id, currentMonth)
  return {
    available: true,
    notice: null,
    currentMonth,
    cycle,
    cycleInProgress,
    rates: ratesAt(rates, currentMonth),
    rateHistory: rates,
    current,
    assignmentCount: assignments.length,
    summary: seatSummary(assignments, rates, ids, currentMonth),
    recurringConflict: await hasCursorRecurringCost(admin, currentMonth),
  }
}

async function hasCursorRecurringCost(admin: SupabaseClient, ym: string): Promise<boolean> {
  const provider = await admin.from("providers").select("id").eq("name", CURSOR_SLUG).maybeSingle()
  const id = (provider.data as { id: string } | null)?.id
  if (!id) return false
  const { data, error } = await admin.from("recurring_costs").select(RECURRING_COLUMNS).eq("provider_id", id)
  if (error) {
    if (isMissingRelation(error)) return false
    throw new HttpError(500, error.message)
  }
  return ((data || []) as RecurringCost[]).some((c) => covers(c, ym))
}

function rpcError(error: { code?: string; message?: string }, fallback: string): never {
  if (isMissingSeatTables(error)) throw new HttpError(503, MIGRATION_026_MESSAGE)
  throw new HttpError(400, error.message || fallback)
}

/** Set seat types from cycle `fromMonth` (cycle key YYYY-MM) onward; returns rows written. */
export async function setSeatAssignments(
  admin: SupabaseClient,
  rows: { person_id: string; seat_type: AssignableSeatType }[],
  fromMonth: string,
  source: "admin" | "roster",
  setBy: string | null
): Promise<number> {
  if (!rows.length) return 0
  const { data, error } = await admin.rpc("set_cursor_seat_assignments", {
    p_rows: rows,
    p_from_month: `${fromMonth}-01`,
    p_source: source,
    p_set_by: setBy,
  })
  if (error) rpcError(error, "Failed to save seat types")
  return Number(data) || 0
}

/** Set a seat type's per-cycle rate from cycle `fromMonth` (cycle key YYYY-MM) onward. */
export async function setSeatRate(admin: SupabaseClient, type: SeatType, fromMonth: string, rate: number, setBy: string | null): Promise<void> {
  const { error } = await admin.rpc("set_cursor_seat_rate", {
    p_seat_type: type,
    p_from_month: `${fromMonth}-01`,
    p_rate: rate,
    p_set_by: setBy,
  })
  if (error) rpcError(error, "Failed to save seat rate")
}
