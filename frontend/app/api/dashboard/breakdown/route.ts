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
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import { parseFilters } from "@/lib/dashboard-filters"
import { fetchAttributedDaily, fetchOrgData, fetchProviders, providerIdForSlug, type SupabaseLike } from "@/lib/dashboard-data"
import { computeBreakdown } from "@/lib/org/breakdown"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore) // same gate as /api/dashboard
    // Typed client -> the minimal shape lib/dashboard-data.ts needs (see SupabaseLike).
    const supabase = (await createClient(cookieStore)) as unknown as SupabaseLike

    const sp = request.nextUrl.searchParams
    const filters = parseFilters(sp)

    const [providers, org] = await Promise.all([fetchProviders(supabase), fetchOrgData(supabase)])
    const providerId = providerIdForSlug(providers, filters.provider)
    const rows = await fetchAttributedDaily(supabase, { provider: filters.provider }, providerId)

    return successResponse(
      computeBreakdown({
        rows,
        org,
        providers,
        filters,
        params: { month: sp.get("month"), start: sp.get("start"), end: sp.get("end") },
      })
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard/breakdown error:", error)
    return errorResponse(message || "Failed to load breakdown", 500)
  }
}
