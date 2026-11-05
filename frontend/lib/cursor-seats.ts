/**
 * Cursor seat types per person and the monthly seat fee they cost.
 *
 * The Cursor Admin API reports on-demand usage per member but not the seat
 * type (Standard / Premium / Free) or the monthly seat subscription line on
 * the invoice. Migration 026 stores both by hand:
 *
 * - cursor_seat_assignments: a person's seat type from a month onward
 *   (standard / premium / free / none). The type for month M is the row with
 *   the latest effective_month <= M; no row means unassigned.
 * - cursor_seat_rates: a seat type's monthly rate from a month onward,
 *   seeded Standard $40, Premium $80, Free $0. Admin-editable.
 *
 * Nothing is written to cost_records. At read time each billed person gets
 * one synthetic Cursor row per month, dated the 1st with model_name
 * CURSOR_SEAT_MODEL, attributed to them (and so to their team and
 * department). Free, unassigned ("none") and people with no row cost $0 and
 * get no row. Months before a change keep their earlier type and rate.
 *
 * Coordination with other Cursor amounts in the same month:
 * - Invoice actual (invoice_overrides, migration 024): the invoice is the
 *   billed month total. Seats are composition inside it, never on top: the
 *   seat rows count first (scaled down only if they exceed the invoice), the
 *   month's other Cursor rows are scaled to the remainder, and when there is
 *   no other Cursor spend an org-level remainder row makes up the rest. The
 *   result sums to the invoice, so a later proportional scale to the same
 *   invoice is a no-op.
 * - A recurring Cursor cost (recurring_costs, migration 022) in a month that
 *   has per-person seats would bill the same seat dollars twice; the
 *   recurring row is dropped for that month and the admin card says so.
 *
 * Pure: no I/O. lib/dashboard-data.ts loads the rows (a missing table, i.e.
 * 026 not applied, means no seats and totals unchanged).
 */

import { CURSOR_SEAT_MODEL, RECURRING_MODEL, RECURRING_SEAT_MODEL } from "@/lib/projection"
import { addMonths, toMonth, type RecurringMonthRow } from "@/lib/recurring-costs"

export { CURSOR_SEAT_MODEL }

export const SEAT_TYPES = ["standard", "premium", "free"] as const
export type SeatType = (typeof SEAT_TYPES)[number]
/** What can be assigned to a person: a seat type, or none (unassigned). */
export const ASSIGNABLE_SEAT_TYPES = [...SEAT_TYPES, "none"] as const
export type AssignableSeatType = (typeof ASSIGNABLE_SEAT_TYPES)[number]

export const SEAT_TYPE_LABEL: Record<AssignableSeatType, string> = {
  standard: "Standard",
  premium: "Premium",
  free: "Free",
  none: "Unassigned",
}

/** model_name of the org-level row that fills an invoice month with no other Cursor spend. */
export const CURSOR_INVOICE_REMAINDER_MODEL = "cursor invoice remainder"

export const CURSOR_SLUG = "cursor"

/** A cursor_seat_assignments row as PostgREST returns it. */
export interface SeatAssignment {
  person_id: string
  /** YYYY-MM-01 */
  effective_month: string
  seat_type: AssignableSeatType | string
  source?: string | null
  set_by?: string | null
  updated_at?: string | null
}

/** A cursor_seat_rates row as PostgREST returns it (numerics may be strings). */
export interface SeatRate {
  seat_type: SeatType | string
  /** YYYY-MM-01 */
  effective_month: string
  monthly_rate_usd: number | string
  updated_by?: string | null
  updated_at?: string | null
}

export const SEAT_ASSIGNMENT_COLUMNS = "person_id, effective_month, seat_type, source, set_by, updated_at"
export const SEAT_RATE_COLUMNS = "seat_type, effective_month, monthly_rate_usd, updated_by, updated_at"

export function isSeatType(v: unknown): v is SeatType {
  return typeof v === "string" && (SEAT_TYPES as readonly string[]).includes(v)
}

export function isAssignableSeatType(v: unknown): v is AssignableSeatType {
  return typeof v === "string" && (ASSIGNABLE_SEAT_TYPES as readonly string[]).includes(v)
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

const cents = (n: number) => Math.round(n * 100) / 100

/** Latest row with month <= ym, by effective_month. */
function latestAt<T extends { effective_month: string }>(rows: T[], ym: string): T | null {
  let best: T | null = null
  for (const r of rows) {
    const m = toMonth(r.effective_month)
    if (m > ym) continue
    if (!best || m > toMonth(best.effective_month)) best = r
  }
  return best
}

/** A person's seat type in month `ym` ("none" when unassigned or no row yet). */
export function seatTypeFor(assignments: SeatAssignment[], personId: string, ym: string): AssignableSeatType {
  const row = latestAt(assignments.filter((a) => a.person_id === personId), ym)
  return row && isAssignableSeatType(row.seat_type) ? row.seat_type : "none"
}

/** Monthly rate of a seat type in month `ym`; "none" (and a type with no rate row) is $0. */
export function rateFor(rates: SeatRate[], type: AssignableSeatType, ym: string): number {
  if (type === "none") return 0
  const row = latestAt(rates.filter((r) => r.seat_type === type), ym)
  return row ? cents(num(row.monthly_rate_usd)) : 0
}

/** The seat fee attributed to a person for month `ym`. */
export function seatCostFor(assignments: SeatAssignment[], rates: SeatRate[], personId: string, ym: string): number {
  return rateFor(rates, seatTypeFor(assignments, personId, ym), ym)
}

/** Current rate per seat type for month `ym`. */
export function ratesAt(rates: SeatRate[], ym: string): Record<SeatType, number> {
  return {
    standard: rateFor(rates, "standard", ym),
    premium: rateFor(rates, "premium", ym),
    free: rateFor(rates, "free", ym),
  }
}

export interface SeatSummary {
  month: string
  counts: Record<AssignableSeatType, number>
  rates: Record<SeatType, number>
  total_usd: number
}

/** Seat counts by type and the billed seat total for month `ym` over `personIds`. */
export function seatSummary(assignments: SeatAssignment[], rates: SeatRate[], personIds: string[], ym: string): SeatSummary {
  const counts: Record<AssignableSeatType, number> = { standard: 0, premium: 0, free: 0, none: 0 }
  let total = 0
  for (const id of personIds) {
    const t = seatTypeFor(assignments, id, ym)
    counts[t] += 1
    total += rateFor(rates, t, ym)
  }
  return { month: ym, counts, rates: ratesAt(rates, ym), total_usd: cents(total) }
}

/**
 * One synthetic row per billed person per month, from the earliest
 * assignment month through `currentMonth` (never into the future). People
 * whose seat is Free, unassigned, or costs $0 get no row. `people` maps a
 * person id to their email (rows are attributed by email, like a manual seat
 * row); assignments of an unknown person are skipped.
 */
export function expandCursorSeats(input: {
  assignments: SeatAssignment[]
  rates: SeatRate[]
  people: { id: string; email: string }[]
  cursorProviderId: string
  currentMonth: string
}): RecurringMonthRow[] {
  const { assignments, rates, cursorProviderId, currentMonth } = input
  if (!assignments.length) return []
  const emailOf = new Map(input.people.map((p) => [p.id, p.email]))
  const byPerson = new Map<string, SeatAssignment[]>()
  for (const a of assignments) {
    if (!emailOf.has(a.person_id)) continue
    const list = byPerson.get(a.person_id) ?? []
    list.push(a)
    byPerson.set(a.person_id, list)
  }
  const first = assignments.map((a) => toMonth(a.effective_month)).sort()[0]
  const out: RecurringMonthRow[] = []
  for (let ym = first; ym <= currentMonth; ym = addMonths(ym, 1)) {
    for (const [personId, list] of [...byPerson.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const cost = rateFor(rates, seatTypeFor(list, personId, ym), ym)
      if (cost <= 0) continue
      out.push({
        date: `${ym}-01`,
        month: ym,
        provider_id: cursorProviderId,
        model_name: CURSOR_SEAT_MODEL,
        total_cost_usd: cost,
        total_tokens: 0,
        total_requests: 1,
        record_count: 1,
        recurring_cost_id: `cursor-seat:${personId}`,
        person_email: emailOf.get(personId)!,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Combining seat rows with the rest of a Cursor month
// ---------------------------------------------------------------------------

interface CostRow {
  date: string
  provider_id: string
  model_name?: string | null
  total_cost_usd: number | string
}

export interface InvoiceOverride {
  provider_id: string
  /** YYYY-MM-01 */
  month: string
  billed_amount_usd: number | string
}

/**
 * How seat rows combine with a month's other Cursor rows. Built once from
 * the whole org's numbers, so it can be applied to filtered rows too.
 */
export interface CursorSeatPlan {
  cursorProviderId: string | null
  /** Seat rows (attributed), already scaled for invoice months. */
  seatRows: CostRow[]
  /** YYYY-MM -> factor for the month's other (non-seat, non-recurring) Cursor rows. */
  otherScale: Record<string, number>
  /** Months whose recurring Cursor rows are dropped (seats or an invoice replace them). */
  dropRecurringMonths: string[]
  /** Org-level rows that fill an invoice month with no other Cursor spend. */
  extraRows: CostRow[]
}

export const EMPTY_SEAT_PLAN: CursorSeatPlan = {
  cursorProviderId: null,
  seatRows: [],
  otherScale: {},
  dropRecurringMonths: [],
  extraRows: [],
}

const isRecurringModel = (m: string | null | undefined) => m === RECURRING_MODEL || m === RECURRING_SEAT_MODEL

/**
 * Plan how seat rows join the Cursor months.
 *
 * - A month with seats and no invoice: seats are added; any recurring Cursor
 *   row in that month is dropped (it would bill the same seats twice).
 * - A month with seats and an invoice of B: seat rows S count first (scaled by
 *   B / S if S > B), other Cursor rows (unfiltered total A) are scaled by
 *   (B - S') / A, recurring Cursor rows are dropped, and if A is 0 an
 *   org-level remainder row of B - S' is added. The month sums to B.
 * - A month with an invoice and no seats is left alone (the invoice path
 *   handles it).
 */
export function planCursorSeats<R extends CostRow>(input: {
  cursorProviderId: string
  seatRows: R[]
  overrides: InvoiceOverride[]
  /** YYYY-MM -> whole-org Cursor total excluding seat and recurring rows. */
  otherMonthTotals: Record<string, number>
}): CursorSeatPlan & { seatRows: R[] } {
  const { cursorProviderId } = input
  const seatByMonth = new Map<string, number>()
  for (const r of input.seatRows) {
    const ym = toMonth(r.date)
    seatByMonth.set(ym, (seatByMonth.get(ym) ?? 0) + num(r.total_cost_usd))
  }
  const billed = new Map<string, number>()
  for (const o of input.overrides) {
    if (o.provider_id !== cursorProviderId) continue
    billed.set(toMonth(o.month), num(o.billed_amount_usd))
  }
  const otherScale: Record<string, number> = {}
  const seatScale = new Map<string, number>()
  const extraRows: CostRow[] = []
  for (const [ym, seats] of seatByMonth) {
    const b = billed.get(ym)
    if (b === undefined || seats <= 0) continue
    const sFactor = seats > b ? b / seats : 1
    const seatsIn = seats * sFactor
    const remainder = Math.max(0, b - seatsIn)
    const other = input.otherMonthTotals[ym] ?? 0
    seatScale.set(ym, sFactor)
    otherScale[ym] = other > 0 ? remainder / other : 0
    if (other <= 0 && remainder > 0.000001) {
      // Shaped like an org-level attributed rollup row so filters treat it as one.
      extraRows.push({
        date: `${ym}-01`,
        provider_id: cursorProviderId,
        model_name: CURSOR_INVOICE_REMAINDER_MODEL,
        total_cost_usd: remainder,
        total_tokens: 0,
        total_requests: 0,
        record_count: 1,
        person_id: null,
        org_api_key_id: null,
        team_id: null,
        department_id: null,
        project_id: null,
        workspace_id: null,
        granularity: "org",
      } as CostRow)
    }
  }
  const seatRows = input.seatRows.map((r) => {
    const f = seatScale.get(toMonth(r.date))
    return f === undefined || f === 1 ? r : { ...r, total_cost_usd: num(r.total_cost_usd) * f }
  })
  return {
    cursorProviderId,
    seatRows,
    otherScale,
    dropRecurringMonths: [...seatByMonth.keys()].sort(),
    extraRows,
  }
}

/**
 * Apply a plan to rollup rows (any mix of providers, already narrowed by
 * filters or not): scale the other Cursor rows of invoice months, drop
 * recurring Cursor rows the seats replace, and append the seat and remainder
 * rows. The caller filters the appended rows like the rest.
 */
export function applyCursorSeatPlan<T extends CostRow>(rows: T[], plan: CursorSeatPlan): T[] {
  const pid = plan.cursorProviderId
  if (!pid || (!plan.seatRows.length && !plan.extraRows.length)) return rows
  const drop = new Set(plan.dropRecurringMonths)
  const out: T[] = []
  for (const r of rows) {
    if (r.provider_id !== pid || r.model_name === CURSOR_SEAT_MODEL) {
      out.push(r)
      continue
    }
    const ym = toMonth(r.date)
    if (isRecurringModel(r.model_name) && drop.has(ym)) continue
    const f = plan.otherScale[ym]
    out.push(f === undefined ? r : { ...r, total_cost_usd: num(r.total_cost_usd) * f })
  }
  // Seat rows are attributed rollup rows (attributeRecurringRows) and the
  // remainder row is shaped like one, so they fit any rollup row type.
  out.push(...(plan.seatRows as T[]), ...(plan.extraRows as T[]))
  return out
}

// ---------------------------------------------------------------------------
// Roster import (backfill)
// ---------------------------------------------------------------------------

export interface RosterRow {
  /** 1-based data line (header is line 1). */
  line: number
  name: string
  email: string
  role: string
  seat_type: string
}

/** RFC 4180-ish CSV parse (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  const s = text.replace(/^﻿/, "")
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += c
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""))
}

export class RosterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RosterError"
  }
}

/** Parse a Cursor roster CSV (name, email, role, seat_type, ...; header required). */
export function parseRoster(text: string): RosterRow[] {
  const rows = parseCsv(text)
  if (!rows.length) throw new RosterError("The roster CSV is empty")
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (n: string) => header.indexOf(n)
  const [iName, iEmail, iRole, iType] = ["name", "email", "role", "seat_type"].map(col)
  if (iName < 0 || iType < 0) throw new RosterError("The roster CSV needs name and seat_type columns")
  return rows.slice(1).map((r, i) => ({
    line: i + 2,
    name: (r[iName] ?? "").trim(),
    email: iEmail < 0 ? "" : (r[iEmail] ?? "").trim(),
    role: iRole < 0 ? "" : (r[iRole] ?? "").trim(),
    seat_type: (r[iType] ?? "").trim(),
  }))
}

export type RosterMatch = "email" | "name"

export interface RosterAssignment {
  person_id: string
  seat_type: AssignableSeatType
  matched_by: RosterMatch
  line: number
  name: string
  email: string
  /** The roster says Removed: no billed seat, whatever the seat_type column says. */
  removed: boolean
}

export interface RosterUnmatched {
  line: number
  name: string
  email: string
  seat_type: string
  reason: "email_not_found" | "name_not_found" | "name_ambiguous" | "unknown_seat_type" | "duplicate_person" | "no_name"
}

export interface RosterPlan {
  assignments: RosterAssignment[]
  unmatched: RosterUnmatched[]
  /** Billed counts and total for the matched, non-removed rows at `rates`. */
  counts: Record<AssignableSeatType, number>
}

/**
 * Match roster rows to people. A row with an email matches people.email
 * case-insensitively (and only that). A row without one matches exactly one
 * person whose display_name equals the roster name (trimmed, case-sensitive).
 * Unmatched rows are reported, never created. A Removed row is assigned
 * "none" (no billed seat). The roster's seat_type is case-insensitive.
 */
export function planRosterBackfill(
  rows: RosterRow[],
  people: { id: string; email: string; display_name?: string | null }[]
): RosterPlan {
  const byEmail = new Map<string, string>()
  const byName = new Map<string, string[]>()
  for (const p of people) {
    byEmail.set(p.email.trim().toLowerCase(), p.id)
    const n = (p.display_name ?? "").trim()
    if (n) byName.set(n, [...(byName.get(n) ?? []), p.id])
  }
  const assignments: RosterAssignment[] = []
  const unmatched: RosterUnmatched[] = []
  const seen = new Set<string>()
  const counts: Record<AssignableSeatType, number> = { standard: 0, premium: 0, free: 0, none: 0 }
  for (const r of rows) {
    const miss = (reason: RosterUnmatched["reason"]) =>
      unmatched.push({ line: r.line, name: r.name, email: r.email, seat_type: r.seat_type, reason })
    const removed = r.role.trim().toLowerCase() === "removed"
    const type = r.seat_type.toLowerCase()
    if (!removed && !isSeatType(type)) {
      miss("unknown_seat_type")
      continue
    }
    let personId: string | undefined
    let matchedBy: RosterMatch
    if (r.email) {
      matchedBy = "email"
      personId = byEmail.get(r.email.toLowerCase())
      if (!personId) {
        miss("email_not_found")
        continue
      }
    } else {
      matchedBy = "name"
      if (!r.name) {
        miss("no_name")
        continue
      }
      const ids = byName.get(r.name) ?? []
      if (ids.length > 1) {
        miss("name_ambiguous")
        continue
      }
      personId = ids[0]
      if (!personId) {
        miss("name_not_found")
        continue
      }
    }
    if (seen.has(personId)) {
      miss("duplicate_person")
      continue
    }
    seen.add(personId)
    const seat: AssignableSeatType = removed ? "none" : (type as SeatType)
    counts[seat] += 1
    assignments.push({ person_id: personId, seat_type: seat, matched_by: matchedBy, line: r.line, name: r.name, email: r.email, removed })
  }
  return { assignments, unmatched, counts }
}

/** Billed total of a roster plan at the given rates. */
export function rosterTotal(plan: RosterPlan, rates: Record<SeatType, number>): number {
  return cents(plan.counts.standard * rates.standard + plan.counts.premium * rates.premium + plan.counts.free * rates.free)
}

/** Billed counts and total for the raw roster (every non-removed row), before matching. */
export function rosterRowSummary(rows: RosterRow[], rates: Record<SeatType, number>) {
  const counts: Record<AssignableSeatType, number> = { standard: 0, premium: 0, free: 0, none: 0 }
  for (const r of rows) {
    const t = r.seat_type.toLowerCase()
    if (r.role.trim().toLowerCase() === "removed") counts.none += 1
    else if (isSeatType(t)) counts[t] += 1
  }
  return { counts, total_usd: cents(counts.standard * rates.standard + counts.premium * rates.premium + counts.free * rates.free) }
}

// ---------------------------------------------------------------------------
// Missing migration
// ---------------------------------------------------------------------------

/** PostgREST / Postgres errors meaning a 026 table or function isn't there yet. */
export function isMissingSeatTables(error: unknown): boolean {
  const e = (error ?? {}) as { code?: string; message?: string }
  return (
    e.code === "42P01" ||
    e.code === "PGRST205" ||
    e.code === "PGRST202" ||
    e.code === "42883" ||
    (/cursor_seat_(assignments|rates)|set_cursor_seat/i.test(e.message ?? "") && /does not exist|could not find/i.test(e.message ?? ""))
  )
}

export const MIGRATION_026_MESSAGE =
  "Cursor seat types need database migration 026 (database/migrations/026_cursor_seats.sql), which isn't applied yet. Cursor totals are unchanged until it is."

// ---------------------------------------------------------------------------
// Admin input
// ---------------------------------------------------------------------------

export class SeatInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeatInputError"
  }
}

const MONTH = /^\d{4}-\d{2}$/

/**
 * The month a change takes effect: from_month if given, else the current
 * month. Never before the current month, so past months are not rewritten.
 */
export function parseFromMonth(v: unknown, currentMonth: string): string {
  if (v === undefined || v === null || v === "") return currentMonth
  if (typeof v !== "string" || !MONTH.test(v)) throw new SeatInputError("from_month must be YYYY-MM")
  if (v < currentMonth) throw new SeatInputError(`from_month must not be before the current month (${currentMonth}); past months are not changed`)
  return v
}

export const MAX_SEAT_ROWS = 5000

/** { person_ids: string[] (or person_id), seat_type, from_month? } */
export function parseSeatAssignInput(
  body: unknown,
  knownPersonIds: ReadonlySet<string>,
  currentMonth: string
): { person_ids: string[]; seat_type: AssignableSeatType; from_month: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const raw = Array.isArray(b.person_ids) ? b.person_ids : typeof b.person_id === "string" ? [b.person_id] : null
  if (!raw || !raw.length) throw new SeatInputError("person_ids is required")
  if (raw.length > MAX_SEAT_ROWS) throw new SeatInputError(`At most ${MAX_SEAT_ROWS} people per request`)
  const ids = [...new Set(raw.map((x) => (typeof x === "string" ? x.trim() : "")))]
  const unknown = ids.filter((id) => !id || !knownPersonIds.has(id))
  if (unknown.length) throw new SeatInputError(`Unknown person: ${unknown[0] || "(empty)"}`)
  if (!isAssignableSeatType(b.seat_type)) throw new SeatInputError("seat_type must be standard, premium, free or none")
  return { person_ids: ids, seat_type: b.seat_type, from_month: parseFromMonth(b.from_month, currentMonth) }
}

/** { seat_type: standard|premium|free, monthly_rate_usd: number >= 0, from_month? } */
export function parseSeatRateInput(body: unknown, currentMonth: string): { seat_type: SeatType; monthly_rate_usd: number; from_month: string } {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isSeatType(b.seat_type)) throw new SeatInputError("seat_type must be standard, premium or free")
  const rate = typeof b.monthly_rate_usd === "string" && b.monthly_rate_usd.trim() !== "" ? Number(b.monthly_rate_usd) : b.monthly_rate_usd
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100000) {
    throw new SeatInputError("monthly_rate_usd must be a number between 0 and 100000")
  }
  return { seat_type: b.seat_type, monthly_rate_usd: cents(rate), from_month: parseFromMonth(b.from_month, currentMonth) }
}
