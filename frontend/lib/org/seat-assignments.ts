/**
 * Per-person seat assignment for seat-based manual tools (issue #26), built
 * for Claude Ultra (provider slug `claude-max`) and generic for any provider
 * whose metadata says it bills per seat (ChatGPT, Lovable, ...).
 *
 * Design: no new table. A month's seat entry is split into one manual_entry
 * row per assigned person (metadata.attribution = { granularity: "person",
 * person_email }) plus one remainder row (granularity "org") for unassigned
 * seats. Every row of the split carries the same metadata.seat_group_id, so
 * the month is re-edited and deleted as one unit. The view
 * cost_records_daily_attributed (migrations 010/011/015) already resolves
 * person_email to a person and their team, so nothing downstream changes.
 *
 * Invariant: the split's rows sum to the month's original total exactly.
 * Money is handled in micro-dollars (cost_records.cost_usd is NUMERIC(12,6)),
 * so the remainder absorbs any rounding and nothing is double counted. The
 * swap itself is atomic in SQL: replace_seat_group() (migration 016) deletes
 * the old set and inserts the new one in one transaction and refuses a set
 * whose sum differs from the rows it replaces.
 *
 * Pure: no I/O. The route (app/api/admin/seat-assignments) loads rows,
 * calls planSeatSplit and hands the result to the RPC.
 */

import { normalizeEmail } from "./attribution"

export const MANUAL_METHODS = ["manual_entry", "csv_import"] as const
export const SEAT_ENTRY_TYPE = "monthly_seats"

/** A cost_records row as the route loads it. Numerics may arrive as strings. */
export interface SeatEntryRow {
  id: string
  user_id: string
  provider_id: string
  timestamp: string
  model_name: string
  cost_usd: number | string
  request_count?: number | string | null
  collection_method: string
  metadata: Record<string, unknown> | null
}

export interface SeatProviderLike {
  name?: string | null
  metadata?: Record<string, unknown> | null
}

export interface SeatAssignmentInput {
  person_email: string
  seats: number
  /** Defaults to seats x price_per_seat. */
  cost_usd?: number | null
}

export interface SeatAssignment {
  person_email: string
  seats: number
  cost_usd: number
}

export interface SeatGroup {
  provider_id: string
  month: string
  /** Shared id of a split month; null for a plain (un-split) entry. */
  seat_group_id: string | null
  total_usd: number
  total_seats: number
  price_per_seat: number
  /** Ids of every row the month currently consists of. */
  row_ids: string[]
  assignments: SeatAssignment[]
  remainder: { seats: number; cost_usd: number }
  /** Kept on rewritten rows. */
  user_id: string
  timestamp: string
  model_name: string
  notes: string
}

/** A row to insert (the shape replace_seat_group() reads). */
export interface NewSeatRow {
  user_id: string
  provider_id: string
  timestamp: string
  model_name: string
  cost_usd: number
  request_count: number
  collection_method: "manual_entry"
  metadata: Record<string, unknown>
}

export class SeatPlanError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
    this.name = "SeatPlanError"
  }
}

const MICRO = 1_000_000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export const toMicros = (usd: number) => Math.round(usd * MICRO)
export const fromMicros = (micros: number) => micros / MICRO
const toCents = (usd: number) => Math.round(usd * 100)

/** metadata keys a split owns; stripped before carrying the rest over. */
const SPLIT_KEYS = ["attribution", "seats", "remainder", "seat_group_id", "seat_group_total_usd", "seat_group_total_seats"]

/** Is this provider billed per seat? (providers route sets billing: "seat".) */
export function isSeatProvider(provider: SeatProviderLike | null | undefined): boolean {
  const m = provider?.metadata ?? {}
  return m.billing === "seat" || m.cost_basis === "seat_subscription"
}

export function isSeatEntry(row: Pick<SeatEntryRow, "collection_method" | "metadata">): boolean {
  return (
    (MANUAL_METHODS as readonly string[]).includes(row.collection_method) &&
    row.metadata?.entry_type === SEAT_ENTRY_TYPE
  )
}

/** YYYY-MM from metadata.month, else the timestamp. */
export function entryMonth(row: Pick<SeatEntryRow, "timestamp" | "metadata">): string {
  const m = row.metadata?.month
  return typeof m === "string" && /^\d{4}-\d{2}$/.test(m) ? m : String(row.timestamp).slice(0, 7)
}

export function seatGroupId(row: Pick<SeatEntryRow, "metadata">): string | null {
  const id = row.metadata?.seat_group_id
  return typeof id === "string" && id !== "" ? id : null
}

/**
 * Group seat entries by (provider, month). A month made of several plain
 * entries, or of a split plus a later plain entry, is one group: its total is
 * the sum of all of them.
 */
export function groupSeatEntries(rows: SeatEntryRow[]): SeatGroup[] {
  const byKey = new Map<string, SeatEntryRow[]>()
  for (const r of rows) {
    if (!isSeatEntry(r)) continue
    const key = `${r.provider_id}|${entryMonth(r)}`
    const list = byKey.get(key) ?? []
    list.push(r)
    byKey.set(key, list)
  }
  const groups: SeatGroup[] = []
  for (const list of byKey.values()) {
    // Oldest timestamp first so the kept timestamp/user are stable.
    list.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || a.id.localeCompare(b.id))
    const first = list[0]
    let totalMicros = 0
    let totalSeats = 0
    let remSeats = 0
    let remMicros = 0
    const assignments = new Map<string, SeatAssignment>()
    let price: number | null = null
    let groupId: string | null = null
    for (const r of list) {
      const m = r.metadata ?? {}
      const micros = toMicros(num(r.cost_usd))
      const seats = num(m.seats ?? r.request_count)
      totalMicros += micros
      totalSeats += seats
      if (price === null && num(m.price_per_seat) > 0) price = num(m.price_per_seat)
      groupId ??= seatGroupId(r)
      const attr = m.attribution as Record<string, unknown> | undefined
      const email = attr?.granularity === "person" ? normalizeEmail(attr.person_email) : null
      if (email) {
        const a = assignments.get(email) ?? { person_email: email, seats: 0, cost_usd: 0 }
        a.seats += seats
        a.cost_usd = fromMicros(toMicros(a.cost_usd) + micros)
        assignments.set(email, a)
      } else {
        remSeats += seats
        remMicros += micros
      }
    }
    groups.push({
      provider_id: first.provider_id,
      month: entryMonth(first),
      seat_group_id: groupId,
      total_usd: fromMicros(totalMicros),
      total_seats: totalSeats,
      price_per_seat: price ?? (totalSeats > 0 ? fromMicros(totalMicros) / totalSeats : 0),
      row_ids: list.map((r) => r.id),
      assignments: [...assignments.values()].sort((a, b) => a.person_email.localeCompare(b.person_email)),
      remainder: { seats: remSeats, cost_usd: fromMicros(remMicros) },
      user_id: first.user_id,
      timestamp: first.timestamp,
      model_name: first.model_name || "seats",
      notes: typeof first.metadata?.notes === "string" ? first.metadata.notes : "",
    })
  }
  return groups.sort((a, b) => b.month.localeCompare(a.month) || a.provider_id.localeCompare(b.provider_id))
}

export interface SeatPlan {
  seat_group_id: string | null
  rows: NewSeatRow[]
  assignments: SeatAssignment[]
  remainder: { seats: number; cost_usd: number }
}

/**
 * Plan the rows that replace `group` for these assignments. Throws
 * SeatPlanError when the assignments can't reconcile with the month's total
 * (more seats or more money than the month has), or are malformed.
 *
 * No assignments collapses the month back to one plain org-level entry (no
 * seat_group_id, no attribution), the shape an un-split entry has.
 */
export function planSeatSplit(
  group: SeatGroup,
  input: SeatAssignmentInput[],
  opts: { newGroupId: () => string; baseMetadata?: Record<string, unknown> | null }
): SeatPlan {
  const seen = new Set<string>()
  const assignments: SeatAssignment[] = []
  for (const a of input) {
    const email = normalizeEmail(a.person_email)
    if (!email || !EMAIL_RE.test(email)) throw new SeatPlanError(`Invalid email: ${a.person_email}`)
    if (seen.has(email)) throw new SeatPlanError(`${email} is assigned twice`)
    seen.add(email)
    if (!Number.isInteger(a.seats) || a.seats < 1) throw new SeatPlanError(`Seats for ${email} must be a whole number >= 1`)
    const cost = a.cost_usd ?? a.seats * group.price_per_seat
    if (!Number.isFinite(cost) || cost < 0) throw new SeatPlanError(`Cost for ${email} must be >= 0`)
    assignments.push({ person_email: email, seats: a.seats, cost_usd: fromMicros(toMicros(toCents(cost) / 100)) })
  }

  const totalMicros = toMicros(group.total_usd)
  const assignedMicros = assignments.reduce((s, a) => s + toMicros(a.cost_usd), 0)
  const assignedSeats = assignments.reduce((s, a) => s + a.seats, 0)
  if (assignedSeats > group.total_seats) {
    throw new SeatPlanError(
      `Totals don't reconcile: ${assignedSeats} seats assigned but ${group.month} has ${group.total_seats}`
    )
  }
  if (assignedMicros > totalMicros) {
    throw new SeatPlanError(
      `Totals don't reconcile: $${fromMicros(assignedMicros).toFixed(2)} assigned but ${group.month} totals $${group.total_usd.toFixed(2)}`
    )
  }
  const remainder = { seats: group.total_seats - assignedSeats, cost_usd: fromMicros(totalMicros - assignedMicros) }

  const carried: Record<string, unknown> = { ...(opts.baseMetadata ?? {}) }
  for (const k of SPLIT_KEYS) delete carried[k]
  const base: Record<string, unknown> = {
    ...carried,
    entry_type: SEAT_ENTRY_TYPE,
    month: group.month,
    price_per_seat: group.price_per_seat,
    cost_basis: "seat_subscription",
    notes: group.notes,
  }
  const row = (cost: number, seats: number, metadata: Record<string, unknown>): NewSeatRow => ({
    user_id: group.user_id,
    provider_id: group.provider_id,
    timestamp: group.timestamp,
    model_name: group.model_name,
    cost_usd: cost,
    request_count: seats,
    collection_method: "manual_entry",
    metadata,
  })

  if (assignments.length === 0) {
    return {
      seat_group_id: null,
      rows: [row(group.total_usd, group.total_seats, { ...base, seats: group.total_seats })],
      assignments,
      remainder: { seats: group.total_seats, cost_usd: group.total_usd },
    }
  }

  const id = group.seat_group_id ?? opts.newGroupId()
  const split = { seat_group_id: id, seat_group_total_usd: group.total_usd, seat_group_total_seats: group.total_seats }
  const rows = assignments.map((a) =>
    row(a.cost_usd, a.seats, {
      ...base,
      ...split,
      seats: a.seats,
      attribution: { granularity: "person", person_email: a.person_email },
    })
  )
  if (remainder.seats > 0 || totalMicros - assignedMicros > 0) {
    rows.push(
      row(remainder.cost_usd, remainder.seats, {
        ...base,
        ...split,
        seats: remainder.seats,
        remainder: true,
        attribution: { granularity: "org" },
      })
    )
  }
  return { seat_group_id: id, rows, assignments, remainder }
}

/** Sum of a set of rows in micro-dollars (for reconciliation checks). */
export function sumMicros(rows: { cost_usd: number | string }[]): number {
  return rows.reduce((s, r) => s + toMicros(num(r.cost_usd)), 0)
}
