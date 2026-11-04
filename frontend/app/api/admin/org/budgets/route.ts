/**
 * Monthly budgets (issue #49).
 *
 * GET  /api/admin/org/budgets  every budget with this month's actual and #39
 *      projection, its state (over / projected_over / ok) and the alert
 *      settings (mode and which env var names are set; never values).
 *      Without migration 020: 200 { available: false, notice: "Migration 020
 *      not applied: ...", statuses: [] }.
 * POST /api/admin/org/budgets  { scope, subject_id, monthly_usd, note? }
 *      creates or replaces the budget for that person / team / project.
 *      Without migration 020: 409 { code: "migration_020_not_applied" }.
 */

import { adminRoute, json, parseBody } from "@/lib/org/admin/http"
import { budgetInputSchema, loadBudgetsResponse, saveBudget } from "@/lib/org/admin/budgets"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => json(await loadBudgetsResponse(admin)))

export const POST = adminRoute(async (request, _params, admin, user) => {
  const body = await parseBody(request, budgetInputSchema)
  return json(await saveBudget(admin, body, user.email), 201)
})
