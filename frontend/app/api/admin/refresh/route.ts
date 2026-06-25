/**
 * Owner-only manual refresh of the dashboard rollup.
 *
 * POST /api/admin/refresh — refreshes the cost_records_daily materialized view
 * the dashboard reads from. Manual entries and on-demand pulls already refresh
 * automatically; this is an explicit "update the dashboard now" control.
 */

import { cookies } from "next/headers"
import { requireAdmin, errorResponse, successResponse } from "@/lib/db"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)
    await refreshDailyAggregates()
    return successResponse({ message: "Dashboard refreshed" })
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    return errorResponse(e?.message || "Failed to refresh", 500)
  }
}
