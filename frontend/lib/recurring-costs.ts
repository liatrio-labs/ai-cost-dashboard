/**
 * Recurring monthly costs (issue #59): licenses and flat-fee tools (Claude
 * Ultra, Lovable, ChatGPT Business) that count for every month until changed
 * or ended, without anyone entering them.
 *
 * Storage (migration 022): recurring_costs holds one row per segment of a
 * provider: monthly amount (optionally seats x price per seat), start month,
 * optional end month, note. A change "from month M onward" ends the segment
 * covering M at M - 1 and starts a new one at M (set_recurring_cost()), so
 * earlier months never change. Segments of a provider never overlap.
 *
 * Nothing is written to cost_records. The dashboard routes expand the
 * segments at read time into one synthetic row per covered month, dated the
 * 1st like a monthly manual entry, and add them to the rollup rows:
 *
 * - Months: start_month through end_month, or through the current month when
 *   open-ended (never into the future).
 * - Override: a provider-month with any manual row (manual_entry or
 *   csv_import, month from metadata.month else the timestamp) keeps the
 *   manual row(s) and gets no recurring row, so nothing is counted twice and
 *   no past month changes.
 * - Seats (migration 016): a seat segment inherits the person split of the
 *   provider's most recent manual seat entry before that month: each assigned
 *   person gets seats x price_per_seat (attributed to them, and through them
 *   to their team), the remainder stays org-level. A split that no longer
 *   fits (more seats or money assigned than the segment has) is not applied
 *   and the whole month stays org-level. Flat segments are org-level.
 *
 * Rows are dated the 1st with model_name "recurring" (flat) or "recurring
 * seats"; lib/projection.ts counts both as seat spend that is never carried
 * into a month without one.
 *
 * Pure: no I/O. lib/dashboard-data.ts loads the rows (and treats a missing
 * recurring_costs table, i.e. 022 not applied, as no recurring costs).
 */

import { RECURRING_MODEL, RECURRING_SEAT_MODEL } from "@/lib/projection"
import type { AttributedDailyRow, ResolvedAttribution } from "@/lib/org/types"
import {
  entryMonth,
  fromMicros,
  groupSeatEntries,
  MANUAL_METHODS,
  toMicros,
  type SeatEntryRow,
} from "@/lib/org/seat-assignments"

/** A recurring_costs row as PostgREST returns it (numerics may be strings). */
export interface RecurringCost {
  id: string
  provider_id: string
  /** YYYY-MM-01 */
  start_month: string
  /** YYYY-MM-01, inclusive; null = open-ended */
  end_month: string | null
  monthly_cost_usd: number | string
  seats?: number | string | null
  price_per_seat?: number | string | null
  notes?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export const RECURRING_COLUMNS =
  "id, provider_id, start_month, end_month, monthly_cost_usd, seats, price_per_seat, notes, created_at, updated_at"

/** A manual cost_records row, as loaded to decide overrides and seat splits. */
export type ManualCostRow = SeatEntryRow

/** A synthetic month row before attribution is resolved. */
export interface RecurringMonthRow {
  date: string
  month: string
  provider_id: string
  model_name: string
  total_cost_usd: number
  total_tokens: number
  total_requests: number
  record_count: number
  recurring_cost_id: string
  /** Set for a seat assigned to a person; null = org-level. */
  person_email: string | null
}

const MONTH_RE = /^\d{4}-\d{2}$/

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** "2026-06-01" (or "2026-06") -> "2026-06". */
export const toMonth = (d: string): string => String(d).slice(0, 7)

export function isMonth(s: unknown): s is string {
  return typeof s === "string" && MONTH_RE.test(s)
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/** UTC month of `now` (the dashboard's period clock). */
export const currentMonthOf = (now: Date): string => now.toISOString().slice(0, 7)

/** Does this segment cover month `ym`? (Ignores the current-month cap.) */
export function covers(c: RecurringCost, ym: string): boolean {
  return toMonth(c.start_month) <= ym && (!c.end_month || ym <= toMonth(c.end_month))
}

/** Months a segment counts for: start through end, or through `currentMonth` if open-ended or later. */
export function segmentMonths(c: RecurringCost, currentMonth: string): string[] {
  const start = toMonth(c.start_month)
  const end = c.end_month && toMonth(c.end_month) < currentMonth ? toMonth(c.end_month) : currentMonth
  const out: string[] = []
  for (let m = start; m <= end; m = addMonths(m, 1)) out.push(m)
  return out
}

/** The segment of `providerId` covering `ym`, if any. */
export function segmentFor(costs: RecurringCost[], providerId: string, ym: string): RecurringCost | null {
  return costs.find((c) => c.provider_id === providerId && covers(c, ym)) ?? null
}

/**
 * Providers with an active recurring cost in month `ym`. Used to suppress the
 * sync-freshness "no <month> entry" warning (lib/sync-freshness.ts).
 */
export function coveredProviderIds(costs: RecurringCost[], ym: string): Set<string> {
  return new Set(costs.filter((c) => covers(c, ym)).map((c) => c.provider_id))
}

const overrideKey = (providerId: string, ym: string) => `${providerId}|${ym}`

/** provider|month keys that have a manual entry (these win over a recurring cost). */
export function manualMonthKeys(rows: Pick<ManualCostRow, "provider_id" | "timestamp" | "metadata" | "collection_method">[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (!(MANUAL_METHODS as readonly string[]).includes(r.collection_method)) continue
    out.add(overrideKey(r.provider_id, entryMonth(r)))
  }
  return out
}

interface Assignment {
  person_email: string
  seats: number
}

/** provider id -> seat groups with their month and assignments, oldest first. */
function seatHistory(rows: ManualCostRow[]): Map<string, { month: string; assignments: Assignment[] }[]> {
  const out = new Map<string, { month: string; assignments: Assignment[] }[]>()
  for (const g of groupSeatEntries(rows)) {
    const list = out.get(g.provider_id) ?? []
    list.push({ month: g.month, assignments: g.assignments.map((a) => ({ person_email: a.person_email, seats: a.seats })) })
    out.set(g.provider_id, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.month.localeCompare(b.month))
  return out
}

/** Assignments of the latest manual seat entry strictly before `ym`. */
function inheritedAssignments(history: { month: string; assignments: Assignment[] }[] | undefined, ym: string): Assignment[] {
  if (!history) return []
  let found: Assignment[] = []
  for (const h of history) {
    if (h.month >= ym) break
    found = h.assignments
  }
  return found
}

/**
 * Expand recurring segments into one synthetic row per covered month (plus
 * one per assigned person for an inherited seat split), skipping months that
 * have a manual entry. See the file comment for the rules.
 */
export function expandRecurringCosts(input: {
  costs: RecurringCost[]
  manualRows: ManualCostRow[]
  currentMonth: string
}): RecurringMonthRow[] {
  const overridden = manualMonthKeys(input.manualRows)
  const history = seatHistory(input.manualRows)
  const out: RecurringMonthRow[] = []
  const sorted = [...input.costs].sort(
    (a, b) => a.provider_id.localeCompare(b.provider_id) || a.start_month.localeCompare(b.start_month)
  )
  for (const c of sorted) {
    const amountMicros = toMicros(num(c.monthly_cost_usd))
    const seats = c.seats == null ? null : num(c.seats)
    const price = c.price_per_seat == null ? null : num(c.price_per_seat)
    const isSeat = seats !== null && seats > 0 && price !== null
    for (const ym of segmentMonths(c, input.currentMonth)) {
      if (overridden.has(overrideKey(c.provider_id, ym))) continue
      const base = {
        date: `${ym}-01`,
        month: ym,
        provider_id: c.provider_id,
        model_name: isSeat ? RECURRING_SEAT_MODEL : RECURRING_MODEL,
        total_tokens: 0,
        record_count: 1,
        recurring_cost_id: c.id,
      }
      const assignments = isSeat ? inheritedAssignments(history.get(c.provider_id), ym) : []
      const assignedSeats = assignments.reduce((s, a) => s + a.seats, 0)
      const perSeatMicros = isSeat ? toMicros(price!) : 0
      const assignedMicros = assignedSeats * perSeatMicros
      const fits = assignments.length > 0 && assignedSeats <= seats! && assignedMicros <= amountMicros
      if (!fits) {
        out.push({ ...base, total_cost_usd: fromMicros(amountMicros), total_requests: isSeat ? seats! : 1, person_email: null })
        continue
      }
      for (const a of assignments) {
        out.push({
          ...base,
          total_cost_usd: fromMicros(a.seats * perSeatMicros),
          total_requests: a.seats,
          person_email: a.person_email,
        })
      }
      const remSeats = seats! - assignedSeats
      const remMicros = amountMicros - assignedMicros
      if (remSeats > 0 || remMicros > 0) {
        out.push({ ...base, total_cost_usd: fromMicros(remMicros), total_requests: remSeats, person_email: null })
      }
    }
  }
  return out
}

const ORG_LEVEL: ResolvedAttribution = {
  person_id: null,
  org_api_key_id: null,
  team_id: null,
  department_id: null,
  project_id: null,
  workspace_id: null,
  granularity: "org",
}

/**
 * Attribute synthetic rows like cost_records_daily_attributed does for a
 * manual seat row (metadata.attribution = { granularity: "person",
 * person_email }). `resolve` is lib/org/attribution.ts resolveAttribution
 * bound to an org index; without it person rows stay person-granular but
 * unresolved (person_id null), which is what the view does for an unknown
 * email.
 */
export function attributeRecurringRows(
  rows: RecurringMonthRow[],
  resolve?: (record: { provider_id: string; metadata: Record<string, unknown> }) => ResolvedAttribution
): AttributedDailyRow[] {
  return rows.map((r) => {
    const attr: ResolvedAttribution = r.person_email
      ? resolve
        ? resolve({ provider_id: r.provider_id, metadata: { attribution: { granularity: "person", person_email: r.person_email } } })
        : { ...ORG_LEVEL, granularity: "person" }
      : ORG_LEVEL
    return {
      ...attr,
      date: r.date,
      provider_id: r.provider_id,
      model_name: r.model_name,
      total_cost_usd: r.total_cost_usd,
      total_tokens: r.total_tokens,
      total_requests: r.total_requests,
      record_count: r.record_count,
    }
  })
}

/** PostgREST / Postgres errors meaning recurring_costs (migration 022) isn't there yet. */
export function isMissingRelation(error: unknown): boolean {
  const e = (error ?? {}) as { code?: string; message?: string }
  return (
    e.code === "42P01" || // undefined_table
    e.code === "PGRST205" || // table not in schema cache
    e.code === "PGRST202" || // function not in schema cache
    e.code === "42883" || // undefined_function
    /relation .*recurring_costs.* does not exist|could not find the (table|function) .*recurring_cost/i.test(e.message ?? "")
  )
}

export const MIGRATION_022_MESSAGE =
  "Recurring costs need database migration 022 (database/migrations/022_recurring_costs.sql), which isn't applied yet."

/** Round to cents. */
export const cents = (n: number) => Math.round(n * 100) / 100

export interface RecurringInput {
  provider_id: string
  /** YYYY-MM: the change takes effect from this month onward. */
  from_month: string
  /** null ends the recurring cost from from_month (last month = from_month - 1). */
  monthly_cost_usd: number | null
  seats?: number | null
  price_per_seat?: number | null
  /** YYYY-MM, inclusive; null/undefined = open-ended. */
  end_month?: string | null
  notes?: string | null
}

export class RecurringInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RecurringInputError"
  }
}

/**
 * Validate an admin request body into a RecurringInput. Seats and price go
 * together and then set the amount (seats x price, to the cent); otherwise
 * the amount is required. `end: true` ends the cost from from_month.
 */
export function parseRecurringInput(body: unknown): RecurringInput {
  const b = (body ?? {}) as Record<string, unknown>
  const providerId = typeof b.provider_id === "string" ? b.provider_id.trim() : ""
  if (!providerId) throw new RecurringInputError("provider_id is required")
  const from = b.from_month
  if (!isMonth(from)) throw new RecurringInputError("from_month must be YYYY-MM")
  if (b.end === true) return { provider_id: providerId, from_month: from, monthly_cost_usd: null }

  const opt = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v))
  const seats = opt(b.seats)
  const price = opt(b.price_per_seat)
  let amount: number
  if (seats !== null || price !== null) {
    if (seats === null || !Number.isInteger(seats) || seats < 1) throw new RecurringInputError("seats must be a whole number >= 1")
    if (price === null || !Number.isFinite(price) || price < 0) throw new RecurringInputError("price_per_seat must be >= 0")
    amount = cents(seats * cents(price))
  } else {
    const a = opt(b.monthly_cost_usd)
    if (a === null || !Number.isFinite(a) || a < 0) throw new RecurringInputError("monthly_cost_usd must be a number >= 0")
    amount = cents(a)
  }
  const end = b.end_month === undefined || b.end_month === null || b.end_month === "" ? null : b.end_month
  if (end !== null && !isMonth(end)) throw new RecurringInputError("end_month must be YYYY-MM")
  if (end !== null && end < from) throw new RecurringInputError("end_month must not be before from_month")
  const notes = typeof b.notes === "string" ? b.notes.trim().slice(0, 500) : null
  return {
    provider_id: providerId,
    from_month: from,
    monthly_cost_usd: amount,
    seats: seats === null ? null : seats,
    price_per_seat: price === null ? null : cents(price),
    end_month: end,
    notes: notes || null,
  }
}
