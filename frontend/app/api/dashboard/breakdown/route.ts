/**
 * GET /api/dashboard/breakdown — org spend breakdown (issue #8).
 *
 * Query: ?month=YYYY-MM | ?start=YYYY-MM-DD&end=YYYY-MM-DD, plus the filters in
 * lib/dashboard-filters.ts (department, team, person, key, provider).
 *
 * Reads cost_records_daily_attributed and the org tables (migration 010) and
 * returns spend by department, team, person and API key with Unassigned rows,
 * per-entity change vs the previous period, provider x model detail and
 * provider coverage notes (see lib/org/breakdown.ts for the shape).
 *
 * Org filters are not pushed down here: the comparison period, coverage notes
 * and dropdown options need the provider-scoped rows. The provider filter is.
 *
 * Issue #59: recurring monthly costs (lib/recurring-costs.ts) are appended
 * to the attributed rows for every month they cover without a manual entry.
 *
 * Issue #75: invoice actuals (lib/invoice-overrides.ts, migration 024) scale
 * an overridden provider-month's API rows to the invoiced amount and drop its
 * manual / recurring rows. Without migration 024 nothing changes.
 *
 * Issue #48: the person view (a person filter, level "detail") also gets
 * Claude.ai spend by product. The period's raw Claude.ai records are read
 * from cost_records (product by JSON path, no migration), resolved like the
 * attributed rollup and narrowed to the filters. Optional: on failure the
 * breakdown is returned with claudeAiProducts null.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import type { SupabaseLike } from "@/lib/dashboard-data"
import { loadBreakdown } from "@/lib/dashboard-service"

export const dynamic = "force-dynamic"

// The read model lives in lib/dashboard-service.ts, shared with the MCP server (issue #94).
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore) // shared org-wide view; gate on login only
    // Typed client -> the minimal shape lib/dashboard-data.ts needs (see SupabaseLike).
    const supabase = (await createClient(cookieStore)) as unknown as SupabaseLike
    return successResponse(await loadBreakdown(supabase, request.nextUrl.searchParams))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard/breakdown error:", error)
    return errorResponse(message || "Failed to load breakdown", 500)
  }
}
