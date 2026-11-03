/**
 * Dashboard data API — real aggregation over cost_records for the v0-style UI.
 *
 * GET /api/dashboard[?month=YYYY-MM | ?start=YYYY-MM-DD&end=YYYY-MM-DD]
 *                   [&department=&team=&person=&key=&provider=]
 *
 * Returns everything the dashboard renders, computed from the automated
 * cost_records data (via the cost_records_daily rollup) — no manual/mock data:
 *  - months:        available months (YYYY-MM), newest first
 *  - selectedMonth: the month being shown
 *  - tools:         per-provider spend for the selected month (+ MoM change)
 *  - trends:        total spend per month (with per-provider breakdown)
 *  - byModel:       top models by spend for the selected month
 *  - kpis:          totals and deltas
 *  - forecast:      real history plus a trend projection (flagged projected)
 *
 * With no filters the route reads cost_records_daily exactly as before. Org or
 * provider filters (issue #8, see lib/dashboard-filters.ts) read
 * cost_records_daily_attributed instead and narrow KPIs, trend, tools and
 * models. A team or department filter (alone, or a team within its
 * department) projects that unit's forecast (issue #9, lib/unit-forecast.ts);
 * person/key filters get a trailing 3-month average instead of a projection.
 * The aggregation itself lives in lib/dashboard-compute.ts.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import { getForecastSettings, getForecastUnitOverrides, type ForecastSettings } from "@/lib/forecast-settings"
import {
  computeUnitForecasts,
  forecastUnitForFilters,
  monthlyTotals,
  trailingAverage as trailingAverageOf,
  type UnitForecast,
  type UnitLevel,
} from "@/lib/unit-forecast"
import type { AttributedDailyRow } from "@/lib/org/types"
import { computeDashboard, type DailyRow } from "@/lib/dashboard-compute"
import { applyFilters, hasFilters, parseFilters, type DashboardFilters } from "@/lib/dashboard-filters"
import {
  fetchAllPaged,
  fetchAttributedDaily,
  fetchProviders,
  providerIdForSlug,
  type SupabaseLike,
} from "@/lib/dashboard-data"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore) // shared org-wide view; gate on login only
    // Typed client -> the minimal shape lib/dashboard-data.ts needs (see SupabaseLike).
    const supabase = (await createClient(cookieStore)) as unknown as SupabaseLike

    const sp = request.nextUrl.searchParams
    const filters = parseFilters(sp)
    const filtered = hasFilters(filters)

    const providers = await fetchProviders(supabase)

    const forecastSettings = await getForecastSettings()

    let daily: DailyRow[]
    let unitForecast: UnitForecast | null = null
    let trailingAverage: number | undefined
    const unitSel = forecastUnitForFilters(filters)
    if (unitSel) {
      // Team/department filter (#9): the unit's plateau is allocated from the
      // whole org's trailing spend, so read every attributed row once and
      // narrow in memory.
      const all = await fetchAttributedDaily(supabase, {}, null)
      daily = applyFilters(all, filters, null)
      unitForecast = await unitForecastForFilters(all, filters, unitSel, forecastSettings)
    } else if (filtered) {
      const providerId = providerIdForSlug(providers, filters.provider)
      daily = applyFilters(await fetchAttributedDaily(supabase, filters, providerId), filters, providerId)
      // Person / key (or provider) views get a trailing average, not a forecast.
      const last = monthlyTotals(daily).at(-1)?.month
      if (last && (filters.person || filters.key || filters.project)) trailingAverage = trailingAverageOf(daily, last)
    } else {
      // Pull the daily rollup (real automated data).
      daily = await fetchAllPaged<DailyRow>(
        supabase,
        "cost_records_daily",
        "date, provider_id, model_name, total_cost_usd, total_tokens, total_requests"
      )
    }

    return successResponse({
      ...computeDashboard({
        daily,
        providers,
        params: { month: sp.get("month"), start: sp.get("start"), end: sp.get("end") },
        forecastSettings,
        projectForecast: !filtered,
        unitForecast,
        trailingAverage,
      }),
      filters,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard error:", error)
    return errorResponse(message || "Failed to load dashboard data", 500)
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
  settings: ForecastSettings
): Promise<UnitForecast | null> {
  if (filters.team && filters.department) {
    const teamRows = applyFilters(all, { team: filters.team })
    if (applyFilters(teamRows, { department: filters.department }).length !== teamRows.length) return null
  }
  const overrides = await getForecastUnitOverrides()
  const result = computeUnitForecasts({ rows: all, level: sel.level, settings, overrides, include: [sel.key] })
  return result.units.find((u) => u.key === sel.key) ?? null
}
