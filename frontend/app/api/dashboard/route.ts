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
 * models; the org-wide forecast projection is then left out (history only).
 * The aggregation itself lives in lib/dashboard-compute.ts.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import { getForecastSettings } from "@/lib/forecast-settings"
import { computeDashboard, type DailyRow } from "@/lib/dashboard-compute"
import { applyFilters, hasFilters, parseFilters } from "@/lib/dashboard-filters"
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

    let daily: DailyRow[]
    if (filtered) {
      const providerId = providerIdForSlug(providers, filters.provider)
      daily = applyFilters(await fetchAttributedDaily(supabase, filters, providerId), filters, providerId)
    } else {
      // Pull the daily rollup (real automated data).
      daily = await fetchAllPaged<DailyRow>(
        supabase,
        "cost_records_daily",
        "date, provider_id, model_name, total_cost_usd, total_tokens, total_requests"
      )
    }

    const forecastSettings = await getForecastSettings()

    return successResponse({
      ...computeDashboard({
        daily,
        providers,
        params: { month: sp.get("month"), start: sp.get("start"), end: sp.get("end") },
        forecastSettings,
        projectForecast: !filtered,
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
