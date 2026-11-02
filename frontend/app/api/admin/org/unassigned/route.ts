/**
 * GET /api/admin/org/unassigned[?month=YYYY-MM] — spend in the month (default:
 * current UTC month) that resolves to no team, grouped by person email, API
 * key or project (in that order; each record lands in one group), with the
 * org total so the queue can be reconciled.
 */

import { adminRoute, json } from "@/lib/org/admin/http"
import { buildUnassignedQueue, currentMonth, monthRange } from "@/lib/org/admin/observed"
import { loadOrg, scanRecords } from "@/lib/org/admin/repo"
import { monthSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (request, _params, admin) => {
  const month = monthSchema.parse(request.nextUrl.searchParams.get("month") ?? currentMonth())
  const org = await loadOrg(admin)
  const records = await scanRecords(admin, monthRange(month))
  return json(buildUnassignedQueue(records, org, month))
})
