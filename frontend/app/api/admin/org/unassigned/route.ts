/**
 * GET /api/admin/org/unassigned[?month=YYYY-MM] — the Unassigned queue: spend
 * in the month (default: current UTC month) that resolves to no team, grouped
 * by person email, API key or project. Groups sum to unassigned_cost_usd, and
 * assigned + unassigned = total.
 */

import { NextResponse, type NextRequest } from "next/server"
import { loadCostRecords, loadOrgData, withAdmin } from "@/lib/org/admin-server"
import { currentMonth, monthBounds, unassignedQueue } from "@/lib/org/observed"
import { monthSchema } from "@/lib/org/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  return withAdmin("Failed to load the Unassigned queue", async ({ admin }) => {
    const month = monthSchema.parse(request.nextUrl.searchParams.get("month") ?? currentMonth())
    const { start, end } = monthBounds(month)
    const [org, records] = await Promise.all([loadOrgData(admin), loadCostRecords(admin, { start, end })])
    return NextResponse.json({ month, ...unassignedQueue(records, org) })
  })
}
