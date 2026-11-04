/**
 * Recurring monthly costs (issue #59). Admin only.
 *
 * GET  /api/admin/recurring-costs
 *   -> { available, currentMonth, costs: RecurringCost[] }
 *   available is false (and costs empty) while migration 022 isn't applied.
 *
 * POST /api/admin/recurring-costs
 *   { provider_id, from_month: "YYYY-MM", monthly_cost_usd? | seats + price_per_seat,
 *     end_month?: "YYYY-MM", notes? }   set the cost from from_month onward
 *   { provider_id, from_month, end: true }   end it: from_month on has no recurring cost
 *   Months before from_month are never changed (set_recurring_cost(), 022).
 *   -> { costs: RecurringCost[] } (that provider's segments after the change)
 *
 * Errors: 400 malformed input or refused by the database, 404 unknown
 * provider, 409 overlapping segment, 503 migration 022 not applied.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { requireAdmin } from "@/lib/db"
import { createAdminClient } from "@/lib/supabase/admin"
import { HttpError, json, must, readJson, toErrorResponse } from "@/lib/org/admin/http"
import { applyRecurringCost, listRecurringCosts } from "@/lib/recurring-costs-admin"
import { currentMonthOf, parseRecurringInput, RecurringInputError } from "@/lib/recurring-costs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await requireAdmin(await cookies())
    const { available, costs } = await listRecurringCosts(createAdminClient())
    return json({ available, currentMonth: currentMonthOf(new Date()), costs })
  } catch (e) {
    return toErrorResponse(e)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAdmin(await cookies())
    let input
    try {
      input = parseRecurringInput(await readJson(request))
    } catch (e) {
      if (e instanceof RecurringInputError) throw new HttpError(400, e.message)
      throw e
    }
    const admin = createAdminClient()
    const provider = must(await admin.from("providers").select("id").eq("id", input.provider_id).maybeSingle())
    if (!provider) throw new HttpError(404, "Unknown provider")
    await applyRecurringCost(admin, input, user.id)
    const { costs } = await listRecurringCosts(admin)
    return json({ costs: costs.filter((c) => c.provider_id === input.provider_id) })
  } catch (e) {
    return toErrorResponse(e)
  }
}
