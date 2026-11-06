/**
 * The dashboard's read models, shared by the HTTP routes (/api/dashboard,
 * /api/dashboard/breakdown, /api/dashboard/cursor-cycle) and the MCP server
 * (issue #94, app/api/mcp). Each loader takes an already-authenticated
 * Supabase client (the caller's own session, so RLS applies exactly as in the
 * web app) and the same query parameters the route accepts, and returns the
 * route's JSON payload. There is one spend formula: the routes and the MCP
 * tools both call these.
 *
 * Read-only: nothing here writes, collects or calls a provider.
 */

import { getForecastSettings, getForecastUnitOverrides, type ForecastSettings } from "@/lib/forecast-settings"
import {
  computeUnitForecasts,
  forecastUnitForFilters,
  monthlyTotals,
  prevMonth,
  trailingAverage as trailingAverageOf,
  type UnitForecast,
  type UnitLevel,
} from "@/lib/unit-forecast"
import type { AttributedDailyRow, OrgData } from "@/lib/org/types"
import {
  computeDashboard,
  resolvePeriod,
  type DailyRow,
  type PeriodParams,
  type ProviderRow,
} from "@/lib/dashboard-compute"
import { CLAUDE_AI_SLUG, toProductDayRows, type ProductDayRow } from "@/lib/claude-ai-products"
import { buildOrgIndex } from "@/lib/org/attribution"
import { automationProviderIds } from "@/lib/org/rollup"
import { projectionContext } from "@/lib/projection"
import { applyInvoicePlanToRaw, type InvoicePlan } from "@/lib/invoice-overrides"
import { applySpendPlans, EMPTY_SEAT_PLAN } from "@/lib/cursor-seats"
import { applyFilters, drillLevel, hasFilters, parseFilters, type DashboardFilters } from "@/lib/dashboard-filters"
import { computeBreakdown, type BreakdownData } from "@/lib/org/breakdown"
import { readCursorCycleSpend, type ReadClient } from "@/lib/cursor-spend"
import {
  CURSOR_PROVIDER_SLUG,
  cycleScopeBlocker,
  isScopedCycleRequest,
  scopeCursorCycleView,
  type ScopedCursorCycleView,
} from "@/lib/cursor-cycle-scope"
import {
  fetchAllPaged,
  fetchAttributedDaily,
  fetchClaudeAiProductRows,
  fetchIdentities,
  fetchInvoicePlan,
  fetchCursorSeatPlan,
  fetchOrgData,
  fetchProviders,
  fetchRecurringDaily,
  providerIdForSlug,
  type SupabaseLike,
} from "@/lib/dashboard-data"

/** computeDashboard's result (the DashboardData contract) plus the parsed filters. */
export type DashboardPayload = ReturnType<typeof computeDashboard> & { filters: DashboardFilters }

function periodParams(sp: URLSearchParams): PeriodParams {
  return { month: sp.get("month"), start: sp.get("start"), end: sp.get("end") }
}

/** GET /api/dashboard's payload (see that route for the contract). */
export async function loadDashboard(
  supabase: SupabaseLike,
  sp: URLSearchParams,
  now: Date = new Date()
): Promise<DashboardPayload> {
  const filters = parseFilters(sp)
  const filtered = hasFilters(filters)

  const providers = await fetchProviders(supabase)

  const forecastSettings = await getForecastSettings()

  const params = periodParams(sp)
  // Issue #75: invoice actuals (empty plan without 024).
  const planPromise = fetchInvoicePlan(supabase)
  // Issue #48: read in parallel with the rollup; ignored when the period has no Claude.ai spend.
  const productsPromise = claudeAiProducts(supabase, providers, filters, params, now, planPromise)
  // Issue #59: synthetic monthly rows for recurring costs (empty without 022).
  const recurringPromise = fetchRecurringDaily(supabase, { now })
  // Cursor seat fees per person (migration 026; no seats without it, so totals are unchanged).
  const seatsPromise = fetchCursorSeatPlan(supabase, { now, providers })

  let daily: DailyRow[]
  let unitForecast: UnitForecast | null = null
  let trailingAverage: number | undefined
  const unitSel = forecastUnitForFilters(filters)
  if (unitSel) {
    // Team/department filter (#9): the unit's plateau is allocated from the
    // whole org's trailing spend, so read every attributed row once and
    // narrow in memory.
    const all = applySpendPlans(
      [...(await fetchAttributedDaily(supabase, {}, null)), ...(await recurringPromise)],
      await planPromise,
      await seatsPromise
    )
    daily = applyFilters(all, filters, null, automationProviderIds(providers))
    unitForecast = await unitForecastForFilters(all, filters, unitSel, forecastSettings, providers, now)
  } else if (filtered) {
    const providerId = providerIdForSlug(providers, filters.provider)
    const rows = applySpendPlans(
      [...(await fetchAttributedDaily(supabase, filters, providerId)), ...(await recurringPromise)],
      await planPromise,
      await seatsPromise,
      { providerId }
    )
    daily = applyFilters(rows, filters, providerId, automationProviderIds(providers))
    // Person / key / project views get a trailing average, not a forecast
    // (plus the projected current month, from computeDashboard). The
    // average ends at the last complete month, never the partial one (#39).
    const lastData = monthlyTotals(daily).at(-1)?.month
    const lastComplete = prevMonth(now.toISOString().slice(0, 7))
    const last = lastData && lastData < lastComplete ? lastData : lastComplete
    if (lastData && (filters.person || filters.key || filters.project)) trailingAverage = trailingAverageOf(daily, last)
  } else {
    // Pull the daily rollup (real automated data).
    daily = await fetchAllPaged<DailyRow>(
      supabase,
      "cost_records_daily",
      "date, provider_id, model_name, total_cost_usd, total_tokens, total_requests"
    )
    daily = applySpendPlans([...daily, ...(await recurringPromise)], await planPromise, await seatsPromise)
  }

  const claudeAiProductRows = await productsPromise
  // Issue #88: stored seat rates, only to describe the seat composition.
  const cursorSeatRates = (await seatsPromise).rates ?? null

  return {
    ...computeDashboard({
      daily,
      providers,
      params,
      forecastSettings,
      now,
      projectForecast: !filtered,
      unitForecast,
      trailingAverage,
      claudeAiProductRows,
      cursorSeatRates,
    }),
    filters,
  }
}

/**
 * The unit forecast for a team/department filter, or null when the filter
 * combination doesn't name one unit (e.g. a team outside the filtered
 * department), in which case the chart shows history only.
 */
async function unitForecastForFilters(
  all: AttributedDailyRow[],
  filters: DashboardFilters,
  sel: { level: UnitLevel; key: string },
  settings: ForecastSettings,
  providers: ProviderRow[],
  now: Date
): Promise<UnitForecast | null> {
  if (filters.team && filters.department) {
    const teamRows = applyFilters(all, { team: filters.team })
    if (applyFilters(teamRows, { department: filters.department }).length !== teamRows.length) return null
  }
  const overrides = await getForecastUnitOverrides()
  const result = computeUnitForecasts({
    rows: all,
    level: sel.level,
    settings,
    overrides,
    include: [sel.key],
    current: projectionContext(providers, now),
    automationProviderIds: automationProviderIds(providers),
  })
  return result.units.find((u) => u.key === sel.key) ?? null
}

/**
 * Issue #48: the period's Claude.ai records with their product, narrowed to
 * the same filters as the rollup rows, or null when there is no Claude.ai
 * provider or the read fails (the dashboard then shows no split). Never throws.
 */
async function claudeAiProducts(
  supabase: SupabaseLike,
  providers: ProviderRow[],
  filters: DashboardFilters,
  params: PeriodParams,
  now: Date,
  planPromise: Promise<InvoicePlan>
): Promise<ProductDayRow[] | null> {
  const providerId = providerIdForSlug(providers, CLAUDE_AI_SLUG)
  if (!providerId) return null
  // A provider filter for another provider leaves no Claude.ai rows to split.
  if (filters.provider && filters.provider !== CLAUDE_AI_SLUG) return null
  const { start, end } = resolvePeriod(params, now)
  const filtered = hasFilters(filters)
  try {
    const rows = applyInvoicePlanToRaw(await fetchClaudeAiProductRows(supabase, providerId, start, end, filtered), await planPromise)
    if (!filtered) return toProductDayRows(rows)
    const [org, identities] = await Promise.all([fetchOrgData(supabase), fetchIdentities(supabase)])
    return toProductDayRows(rows, {
      filters,
      index: buildOrgIndex({ ...org, identities }),
      providerId: providerIdForSlug(providers, filters.provider),
    })
  } catch (error) {
    console.error("dashboard: Claude.ai product split unavailable:", error)
    return null
  }
}

/** GET /api/dashboard/breakdown's payload (see that route for the contract). */
export async function loadBreakdown(
  supabase: SupabaseLike,
  sp: URLSearchParams,
  now: Date = new Date()
): Promise<BreakdownData> {
  const filters = parseFilters(sp)

  const [providers, org] = await Promise.all([fetchProviders(supabase), fetchOrgData(supabase)])
  const providerId = providerIdForSlug(providers, filters.provider)
  const params = periodParams(sp)
  // An unknown provider slug matches nothing (same as fetchAttributedDaily).
  const unknownProvider = !!filters.provider && !providerId
  const planPromise = fetchInvoicePlan(supabase) // issue #75
  const [attributed, recurring, claudeAiProductRows, plan] = await Promise.all([
    fetchAttributedDaily(supabase, { provider: filters.provider }, providerId),
    unknownProvider ? Promise.resolve([]) : fetchRecurringDaily(supabase, { now, providerId, org }),
    personProducts(supabase, providers, org, filters, params, now, planPromise),
    planPromise,
  ])
  // Cursor seat fees per person (migration 026; empty without it).
  const seats = unknownProvider ? EMPTY_SEAT_PLAN : await fetchCursorSeatPlan(supabase, { now, providerId, org, providers })
  const rows = unknownProvider ? [] : applySpendPlans([...attributed, ...recurring], plan, seats, { providerId })

  return computeBreakdown({
    rows,
    org,
    providers,
    filters,
    params,
    now,
    claudeAiProductRows,
  })
}

/**
 * Issue #48: the person view's Claude.ai records for the period, narrowed to
 * the filters, or null when not a person view, there's no Claude.ai provider,
 * or the read fails. Never throws.
 */
async function personProducts(
  supabase: SupabaseLike,
  providers: ProviderRow[],
  org: OrgData,
  filters: DashboardFilters,
  params: PeriodParams,
  now: Date,
  planPromise: Promise<InvoicePlan>
): Promise<ProductDayRow[] | null> {
  if (drillLevel(filters) !== "detail") return null
  if (filters.provider && filters.provider !== CLAUDE_AI_SLUG) return null
  const providerId = providerIdForSlug(providers, CLAUDE_AI_SLUG)
  if (!providerId) return null
  const { start, end } = resolvePeriod(params, now)
  try {
    const [raw, identities, plan] = await Promise.all([
      fetchClaudeAiProductRows(supabase, providerId, start, end, true),
      fetchIdentities(supabase),
      planPromise,
    ])
    const rows = applyInvoicePlanToRaw(raw, plan)
    return toProductDayRows(rows, {
      filters,
      index: buildOrgIndex({ ...org, identities }),
      providerId: providerIdForSlug(providers, filters.provider),
    })
  } catch (error) {
    console.error("breakdown: Claude.ai product split unavailable:", error)
    return null
  }
}

/** GET /api/dashboard/cursor-cycle's payload (see that route for the contract). */
export async function loadCursorCycle(supabase: SupabaseLike, sp: URLSearchParams): Promise<ScopedCursorCycleView> {
  const filters = parseFilters(sp)
  const view = await readCursorCycleSpend(supabase as unknown as ReadClient)

  // Org data only when an org filter will actually narrow the members.
  const needsOrg = view.available && !!view.current && isScopedCycleRequest(filters) && !cycleScopeBlocker(filters)
  let org = null
  let cursorProviderId: string | null = null
  if (needsOrg) {
    const [providers, orgData, identities] = await Promise.all([
      fetchProviders(supabase),
      fetchOrgData(supabase),
      fetchIdentities(supabase),
    ])
    cursorProviderId = providerIdForSlug(providers, CURSOR_PROVIDER_SLUG)
    // Cursor identities only: the same lookup Cursor usage events get.
    org = { ...orgData, identities: identities.filter((i) => i.provider_id === cursorProviderId) }
  }
  return scopeCursorCycleView(view, filters, { org, cursorProviderId })
}
