/**
 * Invoice actuals per provider + calendar month (issue #75).
 *
 * Storage (migration 024): invoice_overrides holds one row per provider-month
 * with the invoiced amount (billed_amount_usd, net of credits), optional
 * credits, notes and invoice ids, and who entered it. Nothing is written to
 * cost_records; overrides are applied at read time, by every reader of spend
 * rows (dashboard, breakdown, forecast units, budgets and alerts).
 *
 * How an override applies to a provider-month (proportional scaling):
 *
 * 1. Manual entries (manual_entry / csv_import cost_records) and recurring
 *    cost rows (issue #59, model "recurring" / "recurring seats") of the
 *    provider-month are removed: the invoice replaces them, so nothing is
 *    counted twice. Manual rows are inside the rollups, which don't carry
 *    collection_method, so they are removed by (date, model_name): each
 *    rollup row with a manual row's date and model keeps only the fraction of
 *    that key that isn't manual (0 when the key is all manual).
 * 2. What is left are the API rows. Each one's cost is multiplied by
 *    factor = invoiced / API total, where the API total is computed once
 *    from the provider-month's full, unfiltered cost_records_daily rows. Every
 *    view (org, team, person, key, project, product) therefore scales the
 *    same rows by the same factor, so people + Unassigned still sum to the
 *    org total, and the org total for the provider-month is the invoiced
 *    amount exactly (up to float rounding).
 * 3. A provider-month with no API spend to scale (API total 0) instead gets
 *    one org-level row dated the 1st with model "invoice adjustment"
 *    carrying the whole invoiced amount (Unassigned, never automation).
 *
 * Tokens and request counts are not scaled: they stay the usage the API
 * reported. A missing invoice_overrides table (024 not applied) means no
 * overrides, and every reader behaves exactly as before.
 *
 * Pure except for the types it shares with lib/dashboard-data.ts (which does
 * the I/O).
 */

import { INVOICE_ADJUSTMENT_MODEL, RECURRING_MODEL, RECURRING_SEAT_MODEL } from "@/lib/projection"
import { MANUAL_METHODS } from "@/lib/org/seat-assignments"
import type { ResolvedAttribution } from "@/lib/org/types"

export { INVOICE_ADJUSTMENT_MODEL }

/** An invoice_overrides row as PostgREST returns it (numerics may be strings). */
export interface InvoiceOverride {
  id?: string
  provider_id: string
  /** YYYY-MM-01 */
  month: string
  billed_amount_usd: number | string
  credits_usd?: number | string | null
  notes?: string | null
  invoice_ids?: string[] | null
  entered_by?: string | null
  entered_at?: string | null
}

export const INVOICE_OVERRIDE_COLUMNS =
  "id, provider_id, month, billed_amount_usd, credits_usd, notes, invoice_ids, entered_by, entered_at"

/** A cost_records_daily row of an overridden provider-month (the scaling basis). */
export interface BasisRow {
  date: string
  provider_id: string
  model_name: string
  total_cost_usd: number | string
}

/** A manual cost_records row (only what removing it from the rollup needs). */
export interface ManualBasisRow {
  provider_id: string
  timestamp: string
  model_name: string
  cost_usd: number | string
  collection_method: string
}

/** How one overridden provider-month is applied. */
export interface InvoiceMonthPlan {
  provider_id: string
  /** YYYY-MM */
  month: string
  invoiced_usd: number
  /** API spend of the month (rollup minus manual rows), before scaling. */
  api_usd: number
  /** Manual entries in the rollup for the month, removed. */
  manual_usd: number
  /** invoiced / api, or null when there is no API spend (adjustment row instead). */
  factor: number | null
  /** date|model -> fraction of each rollup row with that key that is API (not manual). */
  keep: Map<string, number>
}

export interface InvoicePlan {
  /** provider|YYYY-MM -> plan */
  months: Map<string, InvoiceMonthPlan>
}

export const EMPTY_INVOICE_PLAN: InvoicePlan = { months: new Map() }

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export const monthKey = (providerId: string, ym: string) => `${providerId}|${ym}`
const rowKey = (date: string, model: string | null | undefined) => `${date}|${model ?? ""}`

/** UTC calendar date (YYYY-MM-DD) of a timestamp, as DATE(timestamp) in the rollups. */
export function utcDate(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? String(ts).slice(0, 10) : d.toISOString().slice(0, 10)
}

/** First and last+1 day of a month: [YYYY-MM-01, next YYYY-MM-01). */
export function monthBounds(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number)
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  return { start: `${ym}-01`, end: next }
}

const isRecurringModel = (m: string | null | undefined) => m === RECURRING_MODEL || m === RECURRING_SEAT_MODEL

/**
 * Build the plan from the overrides, the overridden provider-months' full
 * cost_records_daily rows, and the overridden providers' manual rows.
 */
export function buildInvoicePlan(input: {
  overrides: InvoiceOverride[]
  basisRows: BasisRow[]
  manualRows: ManualBasisRow[]
}): InvoicePlan {
  const months = new Map<string, InvoiceMonthPlan>()
  for (const o of input.overrides) {
    const ym = String(o.month).slice(0, 7)
    months.set(monthKey(o.provider_id, ym), {
      provider_id: o.provider_id,
      month: ym,
      invoiced_usd: num(o.billed_amount_usd),
      api_usd: 0,
      manual_usd: 0,
      factor: null,
      keep: new Map(),
    })
  }
  if (!months.size) return EMPTY_INVOICE_PLAN

  // Manual cost per provider-month, per (date, model) key.
  const manualByKey = new Map<string, Map<string, number>>()
  for (const r of input.manualRows) {
    if (!(MANUAL_METHODS as readonly string[]).includes(r.collection_method)) continue
    const date = utcDate(r.timestamp)
    const mk = monthKey(r.provider_id, date.slice(0, 7))
    if (!months.has(mk)) continue
    const m = manualByKey.get(mk) ?? new Map<string, number>()
    m.set(rowKey(date, r.model_name), (m.get(rowKey(date, r.model_name)) ?? 0) + num(r.cost_usd))
    manualByKey.set(mk, m)
  }

  // Rollup total per provider-month, per (date, model) key.
  const rollupByKey = new Map<string, Map<string, number>>()
  for (const r of input.basisRows) {
    const mk = monthKey(r.provider_id, r.date.slice(0, 7))
    if (!months.has(mk) || isRecurringModel(r.model_name)) continue
    const m = rollupByKey.get(mk) ?? new Map<string, number>()
    m.set(rowKey(r.date, r.model_name), (m.get(rowKey(r.date, r.model_name)) ?? 0) + num(r.total_cost_usd))
    rollupByKey.set(mk, m)
  }

  for (const [mk, plan] of months) {
    const rollup = rollupByKey.get(mk) ?? new Map<string, number>()
    const manual = manualByKey.get(mk) ?? new Map<string, number>()
    let api = 0
    let manualTotal = 0
    for (const [k, total] of rollup) {
      const man = manual.get(k) ?? 0
      if (man > 0) {
        const apiPart = Math.max(0, total - man)
        plan.keep.set(k, total > 0 ? apiPart / total : 0)
        manualTotal += Math.min(man, total)
        api += apiPart
      } else {
        api += total
      }
    }
    plan.api_usd = api
    plan.manual_usd = manualTotal
    plan.factor = api > 0 ? plan.invoiced_usd / api : null
  }
  return { months }
}

type CostRow = {
  date: string
  provider_id: string
  model_name: string
  total_cost_usd: number | string
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

/** The org-level row carrying an overridden month's whole invoice when there was no API spend. */
export function adjustmentRow(plan: InvoiceMonthPlan) {
  return {
    ...ORG_LEVEL,
    date: `${plan.month}-01`,
    provider_id: plan.provider_id,
    model_name: INVOICE_ADJUSTMENT_MODEL,
    total_cost_usd: plan.invoiced_usd,
    total_tokens: 0,
    total_requests: 0,
    record_count: 1,
  }
}

/**
 * Apply the plan to spend rows (plain or attributed rollup rows, plus
 * recurring rows). Rows outside overridden provider-months pass through
 * unchanged. Adjustment rows are appended for overridden months with no API
 * spend; pass `adjustments: false` when the caller adds them itself.
 * `providerId` limits adjustments to one provider (a provider filter).
 */
export function applyInvoicePlan<R extends CostRow>(
  rows: R[],
  plan: InvoicePlan,
  opts: { providerId?: string | null; adjustments?: boolean } = {}
): R[] {
  if (!plan.months.size) return rows
  const out: R[] = []
  for (const r of rows) {
    const p = plan.months.get(monthKey(r.provider_id, r.date.slice(0, 7)))
    if (!p) {
      out.push(r)
      continue
    }
    if (isRecurringModel(r.model_name) || r.model_name === INVOICE_ADJUSTMENT_MODEL) continue
    if (p.factor === null) continue // no API spend: the adjustment row carries the invoice
    const keep = p.keep.get(rowKey(r.date, r.model_name)) ?? 1
    if (keep <= 0) continue
    out.push({ ...r, total_cost_usd: num(r.total_cost_usd) * keep * p.factor })
  }
  if (opts.adjustments !== false) {
    for (const p of plan.months.values()) {
      if (p.factor !== null || p.invoiced_usd <= 0) continue
      if (opts.providerId && p.provider_id !== opts.providerId) continue
      out.push(adjustmentRow(p) as unknown as R)
    }
  }
  return out
}

/** Postgres / PostgREST errors meaning invoice_overrides (migration 024) isn't there yet. */
export function isMissingInvoiceTable(error: unknown): boolean {
  const e = (error ?? {}) as { code?: string; message?: string }
  return (
    e.code === "42P01" ||
    e.code === "PGRST205" ||
    /relation .*invoice_overrides.* does not exist|could not find the table .*invoice_overrides/i.test(e.message ?? "")
  )
}

export const MIGRATION_024_NOTICE =
  "Invoice actuals need database migration 024 (database/migrations/024_invoice_overrides.sql), which isn't applied yet. Dashboard totals use API, manual and recurring amounts until it is."

// ---------------------------------------------------------------------------
// Admin input
// ---------------------------------------------------------------------------

export interface InvoiceOverrideInput {
  provider_id: string
  /** YYYY-MM, a complete month (before the current UTC month). */
  month: string
  billed_amount_usd: number
  credits_usd: number | null
  notes: string | null
  invoice_ids: string[]
}

export class InvoiceInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvoiceInputError"
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const cents = (n: number) => Math.round(n * 100) / 100

/**
 * Validate a set request. Only complete months (before `currentMonth`) can be
 * overridden: an invoice exists once the month has closed, and the current
 * month's projection must keep extrapolating usage.
 */
export function parseInvoiceOverrideInput(body: unknown, currentMonth: string): InvoiceOverrideInput {
  const b = (body ?? {}) as Record<string, unknown>
  const providerId = typeof b.provider_id === "string" ? b.provider_id.trim() : ""
  if (!providerId) throw new InvoiceInputError("provider_id is required")
  const month = typeof b.month === "string" ? b.month.trim() : ""
  if (!MONTH_RE.test(month)) throw new InvoiceInputError("month must be YYYY-MM")
  if (month >= currentMonth) throw new InvoiceInputError("Only complete months (before the current month) can have an invoice actual")
  const amount = b.billed_amount_usd === "" || b.billed_amount_usd == null ? NaN : Number(b.billed_amount_usd)
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e10) throw new InvoiceInputError("billed_amount_usd must be a number >= 0")
  let credits: number | null = null
  if (b.credits_usd !== undefined && b.credits_usd !== null && b.credits_usd !== "") {
    credits = Number(b.credits_usd)
    if (!Number.isFinite(credits) || credits < 0 || credits > 1e10) throw new InvoiceInputError("credits_usd must be a number >= 0")
    credits = cents(credits)
  }
  const notes = typeof b.notes === "string" ? b.notes.trim().slice(0, 2000) : ""
  const rawIds = Array.isArray(b.invoice_ids)
    ? b.invoice_ids
    : typeof b.invoice_ids === "string"
      ? b.invoice_ids.split(/[\s,]+/)
      : []
  const ids = [...new Set(rawIds.map((s) => String(s).trim()).filter(Boolean))].slice(0, 50).map((s) => s.slice(0, 200))
  return { provider_id: providerId, month, billed_amount_usd: cents(amount), credits_usd: credits, notes: notes || null, invoice_ids: ids }
}

/**
 * Raw cost_records rows (the Claude.ai product split, issue #48) scaled the
 * same way as their rollup rows, so the split sums to the invoiced amount.
 */
export function applyInvoicePlanToRaw<R extends { provider_id: string; timestamp: string; model_name: string; cost_usd: number | string | null }>(
  rows: R[],
  plan: InvoicePlan
): R[] {
  if (!plan.months.size) return rows
  const out: R[] = []
  for (const r of rows) {
    const date = utcDate(r.timestamp)
    const p = plan.months.get(monthKey(r.provider_id, date.slice(0, 7)))
    if (!p) {
      out.push(r)
      continue
    }
    if (p.factor === null) continue
    const keep = p.keep.get(rowKey(date, r.model_name)) ?? 1
    if (keep <= 0) continue
    out.push({ ...r, cost_usd: num(r.cost_usd) * keep * p.factor })
  }
  return out
}
