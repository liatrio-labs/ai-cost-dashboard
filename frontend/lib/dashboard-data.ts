/**
 * Supabase reads shared by /api/dashboard and /api/dashboard/breakdown.
 * Server-only (takes an authenticated server client); RLS applies.
 */

import type { ProviderRow } from "@/lib/dashboard-compute"
import {
  FILTER_FIELD,
  ORG_FILTER_KEYS,
  AUTOMATION_FILTER,
  UNASSIGNED_FILTER,
  type DashboardFilters,
} from "@/lib/dashboard-filters"
import type { AttributedDailyRow, OrgData, PersonIdentity } from "@/lib/org/types"
import { addDays } from "@/lib/dashboard-compute"
import { buildOrgIndex, resolveAttribution } from "@/lib/org/attribution"
import { MANUAL_METHODS } from "@/lib/org/seat-assignments"
import {
  RECURRING_COLUMNS,
  attributeRecurringRows,
  currentMonthOf,
  expandRecurringCosts,
  isMissingRelation,
  type ManualCostRow,
  type RecurringCost,
} from "@/lib/recurring-costs"
import {
  CURSOR_SLUG,
  CURSOR_SEAT_MODEL,
  EMPTY_SEAT_PLAN,
  SEAT_ASSIGNMENT_COLUMNS,
  SEAT_RATE_COLUMNS,
  expandCursorSeats,
  isMissingSeatTables,
  planCursorSeats,
  type CursorSeatPlan,
  type InvoiceOverride,
  type SeatAssignment,
  type SeatRate,
} from "@/lib/cursor-seats"
import { RECURRING_MODEL, RECURRING_SEAT_MODEL } from "@/lib/projection"
import { PRODUCT_ATTRIBUTION_COLUMN, PRODUCT_COST_COLUMNS, type ProductCostRow } from "@/lib/claude-ai-products"

// Minimal structural types so tests can pass a fake client.
interface QueryResult {
  data: unknown[] | null
  error: unknown
}
export interface Query extends PromiseLike<QueryResult> {
  order(column: string, options?: { ascending?: boolean }): Query
  range(from: number, to: number): Query
  eq(column: string, value: unknown): Query
  is(column: string, value: null): Query
  gte(column: string, value: unknown): Query
  lt(column: string, value: unknown): Query
}
export interface SupabaseLike {
  from(table: string): { select(columns: string): Query }
}

const PAGE = 1000

/**
 * PostgREST caps each request at ~1000 rows, so page through with .range()
 * until everything is fetched. `narrow` adds filters to each page's query.
 */
export async function fetchAllPaged<T>(
  supabase: SupabaseLike,
  table: string,
  columns: string,
  narrow: (q: Query) => Query = (q) => q
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await narrow(supabase.from(table).select(columns))
      .order("date", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data || []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export async function fetchProviders(supabase: SupabaseLike): Promise<ProviderRow[]> {
  const { data, error } = await supabase
    .from("providers")
    .select("id, name, display_name, documentation_url, last_collected_at, metadata")
    .order("display_name")
  if (error) throw error
  return (data || []) as ProviderRow[]
}

export const ATTRIBUTED_COLUMNS =
  "date, provider_id, model_name, person_id, org_api_key_id, team_id, department_id, project_id, workspace_id, granularity, total_cost_usd, total_tokens, total_requests, record_count"

/**
 * Push filters down to PostgREST so a narrow view doesn't page through the
 * whole org. Callers still apply matchesFilters in memory (cheap, and keeps
 * the pure path the single source of truth).
 */
export function narrowAttributed(f: DashboardFilters, providerId: string | null) {
  return (q: Query): Query => {
    for (const k of ORG_FILTER_KEYS) {
      const v = f[k]
      if (!v) continue
      // project also matches workspace_id (issue #28): push down only the
      // superset (project_id IS NULL for "unassigned"); matchesFilters narrows.
      if (k === "project") {
        if (v === UNASSIGNED_FILTER) q = q.is("project_id", null)
        continue
      }
      // "cursor-automation" (issue #51) is a subset of NULL at that level, never an id.
      q = v === UNASSIGNED_FILTER || v === AUTOMATION_FILTER ? q.is(FILTER_FIELD[k], null) : q.eq(FILTER_FIELD[k], v)
    }
    if (f.provider && providerId) q = q.eq("provider_id", providerId)
    return q
  }
}

export async function fetchAttributedDaily(
  supabase: SupabaseLike,
  f: DashboardFilters,
  providerId: string | null
): Promise<AttributedDailyRow[]> {
  // An unknown provider slug matches nothing; skip the round trips.
  if (f.provider && !providerId) return []
  return fetchAllPaged<AttributedDailyRow>(
    supabase,
    "cost_records_daily_attributed",
    ATTRIBUTED_COLUMNS,
    narrowAttributed(f, providerId)
  )
}

const KEY_COLUMNS_BASE = "id, provider_id, external_key_id, name, owner_person_id, team_id"

/**
 * org_api_keys with the key's assigned project (migration 015), so the
 * dashboard can place keys with no spend under their project (issue #28),
 * plus the provider key status (017) and the provider's creation date (018)
 * for the API keys table filters (issue #45). Newest column set first; falls
 * back while 018 / 017 / 015 aren't applied.
 */
const KEY_COLUMN_TIERS = [
  `${KEY_COLUMNS_BASE}, org_project_id, external_status, provider_created_at`,
  `${KEY_COLUMNS_BASE}, org_project_id, external_status`,
  `${KEY_COLUMNS_BASE}, org_project_id`,
  KEY_COLUMNS_BASE,
]

async function fetchOrgKeys(supabase: SupabaseLike) {
  type Res = { data: unknown[] | null; error: { code?: string; message?: string } | null }
  let res: Res = { data: null, error: null }
  for (const columns of KEY_COLUMN_TIERS) {
    res = (await supabase.from("org_api_keys").select(columns).order("name")) as Res
    const missing =
      !!res.error && (res.error.code === "42703" || res.error.code === "PGRST204" || /column .* does not exist/i.test(res.error.message ?? ""))
    if (!missing) return res
  }
  return res
}

/** Org tables (authenticated SELECT, migrations 010/011/015). Identities aren't needed for labels. */
export async function fetchOrgData(supabase: SupabaseLike): Promise<OrgData> {
  const [departments, teams, people, apiKeys, projects] = await Promise.all([
    supabase.from("departments").select("id, name, description").order("name"),
    supabase.from("teams").select("id, name, department_id").order("name"),
    supabase.from("people").select("id, email, display_name, team_id, active").order("email"),
    fetchOrgKeys(supabase),
    supabase.from("org_projects").select("id, provider_id, external_project_id, name, team_id").order("name"),
  ])
  for (const r of [departments, teams, people, apiKeys, projects]) if (r.error) throw r.error
  return {
    departments: (departments.data || []) as OrgData["departments"],
    teams: (teams.data || []) as OrgData["teams"],
    people: (people.data || []) as OrgData["people"],
    identities: [],
    apiKeys: (apiKeys.data || []) as OrgData["apiKeys"],
    projects: (projects.data || []) as NonNullable<OrgData["projects"]>,
  }
}

/**
 * person_identities (authenticated SELECT, migration 010). The product split
 * resolves raw records like cost_records_daily_attributed, which uses them.
 */
export async function fetchIdentities(supabase: SupabaseLike): Promise<PersonIdentity[]> {
  const { data, error } = await supabase.from("person_identities").select("person_id, provider_id, external_id").order("external_id")
  if (error) throw error
  return (data || []) as PersonIdentity[]
}

/**
 * Raw Claude.ai records for [start, end] (UTC dates, inclusive) with the
 * product and attribution pulled out of metadata by JSON path (issue #48).
 * Read straight from cost_records: the rollups don't carry the product.
 * `withAttribution` adds metadata.attribution, needed to apply org filters.
 */
export async function fetchClaudeAiProductRows(
  supabase: SupabaseLike,
  providerId: string,
  start: string,
  end: string,
  withAttribution = false
): Promise<ProductCostRow[]> {
  const columns = withAttribution ? `${PRODUCT_COST_COLUMNS}, ${PRODUCT_ATTRIBUTION_COLUMN}` : PRODUCT_COST_COLUMNS
  const out: ProductCostRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("cost_records")
      .select(columns)
      .eq("provider_id", providerId)
      .gte("timestamp", `${start}T00:00:00Z`)
      .lt("timestamp", `${addDays(end, 1)}T00:00:00Z`)
      .order("timestamp", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data || []) as ProductCostRow[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export function providerIdForSlug(providers: ProviderRow[], slug: string | undefined): string | null {
  if (!slug) return null
  return providers.find((p) => p.name === slug)?.id ?? null
}

/**
 * Recurring cost segments (issue #59, migration 022). A missing table (022
 * not applied yet) reads as no recurring costs, so the dashboard behaves as
 * before; any other error is thrown like the other reads.
 */
export async function fetchRecurringCosts(supabase: SupabaseLike): Promise<RecurringCost[]> {
  const { data, error } = await supabase.from("recurring_costs").select(RECURRING_COLUMNS).order("start_month")
  if (error) {
    if (isMissingRelation(error)) return []
    throw error
  }
  return (data || []) as RecurringCost[]
}

const MANUAL_ROW_COLUMNS = "id, user_id, provider_id, timestamp, model_name, cost_usd, request_count, collection_method, metadata"

/** Manual (manual_entry / csv_import) cost_records of these providers: overrides and seat splits. */
async function fetchManualRows(supabase: SupabaseLike, providerIds: string[]): Promise<ManualCostRow[]> {
  const out: ManualCostRow[] = []
  // One query per (provider, manual method): few of each, and it never pages
  // through an API-collected provider's usage rows.
  for (const pid of providerIds) for (const method of MANUAL_METHODS) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("cost_records")
        .select(MANUAL_ROW_COLUMNS)
        .eq("provider_id", pid)
        .eq("collection_method", method)
        .order("timestamp", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw error
      const rows = (data || []) as ManualCostRow[]
      out.push(...rows.filter((r) => (MANUAL_METHODS as readonly string[]).includes(r.collection_method)))
      if (rows.length < PAGE) break
    }
  }
  return out
}

/**
 * Synthetic monthly rows for every recurring cost (issue #59, see
 * lib/recurring-costs.ts), attributed like cost_records_daily_attributed rows
 * so they can be appended to either rollup. `providerId` narrows to one
 * provider (a provider filter). Empty when 022 isn't applied.
 */
export async function fetchRecurringDaily(
  supabase: SupabaseLike,
  opts: { now: Date; providerId?: string | null; org?: OrgData }
): Promise<AttributedDailyRow[]> {
  let costs = await fetchRecurringCosts(supabase)
  if (opts.providerId) costs = costs.filter((c) => c.provider_id === opts.providerId)
  if (!costs.length) return []
  const manualRows = await fetchManualRows(supabase, [...new Set(costs.map((c) => c.provider_id))])
  const rows = expandRecurringCosts({ costs, manualRows, currentMonth: currentMonthOf(opts.now) })
  if (!rows.some((r) => r.person_email)) return attributeRecurringRows(rows)
  const [org, identities] = await Promise.all([
    opts.org ? Promise.resolve(opts.org) : fetchOrgData(supabase),
    fetchIdentities(supabase),
  ])
  const index = buildOrgIndex({ ...org, identities })
  return attributeRecurringRows(rows, (record) => resolveAttribution(record, index))
}

/**
 * Cursor seat assignments and rates (migration 026). `available` is false
 * while 026 isn't applied: no seats, so Cursor totals are unchanged.
 */
export async function fetchCursorSeatData(
  supabase: SupabaseLike
): Promise<{ available: boolean; assignments: SeatAssignment[]; rates: SeatRate[] }> {
  const [a, r] = await Promise.all([
    supabase.from("cursor_seat_assignments").select(SEAT_ASSIGNMENT_COLUMNS).order("effective_month"),
    supabase.from("cursor_seat_rates").select(SEAT_RATE_COLUMNS).order("effective_month"),
  ])
  for (const res of [a, r]) {
    if (res.error) {
      if (isMissingSeatTables(res.error)) return { available: false, assignments: [], rates: [] }
      throw res.error
    }
  }
  return { available: true, assignments: (a.data || []) as SeatAssignment[], rates: (r.data || []) as SeatRate[] }
}

/**
 * Invoice actuals for one provider (invoice_overrides, migration 024). A
 * missing table means no overrides.
 */
export async function fetchInvoiceOverrides(supabase: SupabaseLike, providerId: string): Promise<InvoiceOverride[]> {
  const { data, error } = await supabase
    .from("invoice_overrides")
    .select("provider_id, month, billed_amount_usd")
    .eq("provider_id", providerId)
    .order("month")
  if (error) {
    const e = error as { code?: string; message?: string }
    if (e.code === "42P01" || e.code === "PGRST205" || /invoice_overrides/i.test(e.message ?? "")) return []
    throw error
  }
  return (data || []) as InvoiceOverride[]
}

/**
 * Whole-org Cursor spend per month for `months` (YYYY-MM), excluding seat and
 * recurring rows: what an invoice month's remainder is spread over.
 */
async function fetchOtherMonthTotals(supabase: SupabaseLike, providerId: string, months: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (!months.length) return out
  const sorted = [...months].sort()
  const [y, m] = sorted[sorted.length - 1].split("-").map(Number)
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  const rows = await fetchAllPaged<{ date: string; model_name: string | null; total_cost_usd: number | string }>(
    supabase,
    "cost_records_daily",
    "date, model_name, total_cost_usd",
    (q) => q.eq("provider_id", providerId).gte("date", `${sorted[0]}-01`).lt("date", end)
  )
  const wanted = new Set(months)
  for (const r of rows) {
    const ym = String(r.date).slice(0, 7)
    if (!wanted.has(ym)) continue
    if (r.model_name === RECURRING_MODEL || r.model_name === RECURRING_SEAT_MODEL || r.model_name === CURSOR_SEAT_MODEL) continue
    out[ym] = (out[ym] ?? 0) + (Number(r.total_cost_usd) || 0)
  }
  return out
}

/**
 * The Cursor seat plan (lib/cursor-seats.ts): attributed per-person seat rows
 * through the current month, plus how they combine with invoice months and
 * recurring Cursor rows. Built from whole-org numbers, so it applies to
 * filtered rows too (applyCursorSeatPlan, then the caller's filters). Empty
 * without migration 026, with no Cursor provider, or under a filter for
 * another provider.
 */
export async function fetchCursorSeatPlan(
  supabase: SupabaseLike,
  opts: { now: Date; providerId?: string | null; org?: OrgData; providers?: ProviderRow[] }
): Promise<CursorSeatPlan> {
  const providers = opts.providers ?? (await fetchProviders(supabase))
  const cursorId = providers.find((p) => p.name === CURSOR_SLUG)?.id ?? null
  if (!cursorId || (opts.providerId && opts.providerId !== cursorId)) return EMPTY_SEAT_PLAN
  const { available, assignments, rates } = await fetchCursorSeatData(supabase)
  if (!available || !assignments.length) return EMPTY_SEAT_PLAN
  const [org, identities] = await Promise.all([
    opts.org ? Promise.resolve(opts.org) : fetchOrgData(supabase),
    fetchIdentities(supabase),
  ])
  const monthRows = expandCursorSeats({
    assignments,
    rates,
    people: org.people,
    cursorProviderId: cursorId,
    currentMonth: currentMonthOf(opts.now),
  })
  if (!monthRows.length) return EMPTY_SEAT_PLAN
  const index = buildOrgIndex({ ...org, identities })
  const seatRows = attributeRecurringRows(monthRows, (record) => resolveAttribution(record, index))
  const seatMonths = new Set(monthRows.map((r) => r.month))
  const overrides = (await fetchInvoiceOverrides(supabase, cursorId)).filter((o) => seatMonths.has(String(o.month).slice(0, 7)))
  const otherMonthTotals = await fetchOtherMonthTotals(supabase, cursorId, overrides.map((o) => String(o.month).slice(0, 7)))
  return planCursorSeats({ cursorProviderId: cursorId, seatRows, overrides, otherMonthTotals })
}
