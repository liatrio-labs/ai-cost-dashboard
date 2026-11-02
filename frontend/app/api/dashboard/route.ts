/**
 * Dashboard data API — real aggregation over cost_records for the v0-style UI.
 *
 * GET /api/dashboard[?month=YYYY-MM | ?start=YYYY-MM-DD&end=YYYY-MM-DD]
 *                   [&department=&team=&person=&key=&provider=]
 *
 * Returns everything the dashboard renders, computed from the automated
 * cost_records data — no manual/mock data:
 *  - months:        available months (YYYY-MM), newest first
 *  - selectedMonth: the month being shown
 *  - tools:         per-provider spend for the selected month (+ MoM change)
 *  - trends:        total spend per month (with per-provider breakdown)
 *  - byModel:       top models by spend for the selected month
 *  - kpis:          totals and deltas
 *  - forecast:      real history plus a trend projection (flagged projected)
 *
 * Without filters this reads cost_records_daily exactly as before. With any
 * filter (issue #8, see lib/dashboard/filters.ts) it reads
 * cost_records_daily_attributed and keeps only the matching rows, so KPIs,
 * tools, trends and models all narrow together. Per-entity breakdowns live in
 * GET /api/dashboard/breakdown.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import { getForecastSettings, plateauForEmployees } from "@/lib/forecast-settings"
import { buildDashboardData, type DailyRow, type ProviderRow } from "@/lib/dashboard/aggregate"
import { applyFilters, hasFilters, parseFilters, parsePeriod } from "@/lib/dashboard/filters"
import { fetchAllRows, fetchAttributedRows, type SupabaseLike } from "@/lib/dashboard/load"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore) // shared org-wide view; gate on login only
    const supabase = (await createClient(cookieStore)) as unknown as SupabaseLike

    // Providers: id -> display name / slug / order
    const { data: providersRaw, error: provErr } = await supabase
      .from("providers")
      .select("id, name, display_name, documentation_url, last_collected_at, metadata")
      .order("display_name")
    if (provErr) throw provErr
    const providers = (providersRaw || []) as ProviderRow[]

    const sp = request.nextUrl.searchParams
    const filters = parseFilters(sp)

    // Pull the daily rollup (real automated data), paging past PostgREST's cap.
    const daily: DailyRow[] = hasFilters(filters)
      ? applyFilters(await fetchAttributedRows(supabase), filters)
      : await fetchAllRows<DailyRow>(
          supabase,
          "cost_records_daily",
          "date, provider_id, model_name, total_cost_usd, total_tokens, total_requests"
        )

    // The forecast ceiling is HEADCOUNT-DRIVEN: at the baseline employee count
    // the plateau is the baseline USD, and each employee above/below scales it
    // by per_person_pct (default 2%). Editable from the admin page.
    const forecastSettings = await getForecastSettings()
    const ceiling = plateauForEmployees(forecastSettings)

    return successResponse({
      ...buildDashboardData(daily, providers, parsePeriod(sp), {
        ceiling,
        meta: {
          employees: forecastSettings.employees,
          plateau: Math.round(ceiling * 100) / 100,
          perPersonPct: forecastSettings.perPersonPct,
          baselineEmployees: forecastSettings.baselineEmployees,
        },
      }),
      ...(hasFilters(filters) ? { filters } : {}),
    })
  } catch (error: any) {
    if (error?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard error:", error)
    return errorResponse(error?.message || "Failed to load dashboard data", 500)
  }
}
