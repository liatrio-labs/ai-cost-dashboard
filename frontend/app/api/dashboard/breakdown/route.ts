/**
 * GET /api/dashboard/breakdown (issue #8)
 *   [?month=YYYY-MM | ?start=YYYY-MM-DD&end=YYYY-MM-DD]
 *   [&department=&team=&person=&key=&provider=]   (id or "unassigned")
 *
 * Spend by department, team, person and API key for the active period from
 * cost_records_daily_attributed, each level with an Unassigned row, change vs
 * the previous month (or preceding window for a custom range), per-provider
 * splits with coverage notes, and filter options. See lib/dashboard/breakdown.ts.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import type { ProviderRow } from "@/lib/dashboard/aggregate"
import { buildBreakdown } from "@/lib/dashboard/breakdown"
import { parseFilters, parsePeriod } from "@/lib/dashboard/filters"
import { fetchAttributedRows, loadOrgData, type SupabaseLike } from "@/lib/dashboard/load"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore)
    const supabase = (await createClient(cookieStore)) as unknown as SupabaseLike

    const { data: providersRaw, error: provErr } = await supabase
      .from("providers")
      .select("id, name, display_name, documentation_url, last_collected_at, metadata")
      .order("display_name")
    if (provErr) throw provErr

    const [rows, org] = await Promise.all([fetchAttributedRows(supabase), loadOrgData(supabase)])
    const sp = request.nextUrl.searchParams

    return successResponse(
      buildBreakdown(rows, org, (providersRaw || []) as ProviderRow[], parsePeriod(sp), parseFilters(sp))
    )
  } catch (error: any) {
    if (error?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard/breakdown error:", error)
    return errorResponse(error?.message || "Failed to load breakdown", 500)
  }
}
