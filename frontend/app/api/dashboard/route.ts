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
 * person/key/project filters get a trailing 3-month average of complete
 * months and the projected current month (issue #39, lib/projection.ts).
 * The aggregation itself lives in lib/dashboard-compute.ts.
 *
 * Issue #59: recurring monthly costs (lib/recurring-costs.ts) are appended
 * to the rollup rows (either one) for every month they cover without a
 * manual entry, before filters apply. Without migration 022 there are none.
 *
 * Issue #75: invoice actuals (lib/invoice-overrides.ts, migration 024) are
 * applied to those rows before filters: an overridden provider-month's API
 * rows are scaled to the invoiced amount and its manual / recurring rows are
 * dropped. Without migration 024 there are none and nothing changes.
 *
 * Issue #48: when the period has Claude.ai spend, the period's raw Claude.ai
 * records are read from cost_records (product by JSON path, no migration) and
 * the Claude.ai tool gets `products` (Claude Code / Chat / Other). Optional:
 * if that read fails, the dashboard renders without the split.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import type { SupabaseLike } from "@/lib/dashboard-data"
import { loadDashboard } from "@/lib/dashboard-service"

export const dynamic = "force-dynamic"

// The read model lives in lib/dashboard-service.ts, shared with the MCP server (issue #94).
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore) // shared org-wide view; gate on login only
    // Typed client -> the minimal shape lib/dashboard-data.ts needs (see SupabaseLike).
    const supabase = (await createClient(cookieStore)) as unknown as SupabaseLike
    return successResponse(await loadDashboard(supabase, request.nextUrl.searchParams))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard error:", error)
    return errorResponse(message || "Failed to load dashboard data", 500)
  }
}
