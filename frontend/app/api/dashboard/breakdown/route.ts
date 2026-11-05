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
import { drillLevel, parseFilters, type DashboardFilters } from "@/lib/dashboard-filters"
import {
  fetchAttributedDaily,
  fetchClaudeAiProductRows,
  fetchIdentities,
  fetchInvoicePlan,
  fetchOrgData,
  fetchProviders,
  fetchRecurringDaily,
  providerIdForSlug,
  type SupabaseLike,
} from "@/lib/dashboard-data"
import { applyInvoicePlan, applyInvoicePlanToRaw, type InvoicePlan } from "@/lib/invoice-overrides"
import { computeBreakdown } from "@/lib/org/breakdown"
import { resolvePeriod, type PeriodParams, type ProviderRow } from "@/lib/dashboard-compute"
import { CLAUDE_AI_SLUG, toProductDayRows, type ProductDayRow } from "@/lib/claude-ai-products"
import { buildOrgIndex } from "@/lib/org/attribution"
import type { OrgData } from "@/lib/org/types"

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
    const params = { month: sp.get("month"), start: sp.get("start"), end: sp.get("end") }
    const now = new Date()
    // An unknown provider slug matches nothing (same as fetchAttributedDaily).
    const unknownProvider = !!filters.provider && !providerId
    const planPromise = fetchInvoicePlan(supabase) // issue #75
    const [attributed, recurring, claudeAiProductRows, plan] = await Promise.all([
      fetchAttributedDaily(supabase, { provider: filters.provider }, providerId),
      unknownProvider ? Promise.resolve([]) : fetchRecurringDaily(supabase, { now, providerId, org }),
      personProducts(supabase, providers, org, filters, params, now, planPromise),
      planPromise,
    ])
    const rows = unknownProvider ? [] : applyInvoicePlan([...attributed, ...recurring], plan, { providerId })

    return successResponse(
      computeBreakdown({
        rows,
        org,
        providers,
        filters,
        params,
        now,
        claudeAiProductRows,
      })
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard/breakdown error:", error)
    return errorResponse(message || "Failed to load breakdown", 500)
  }
}

/**
 * Issue #48: the person view's Claude.ai records for the period, narrowed to
 * the filters, or null when not a person view, there's no Claude.ai provider,
 * or the read fails. Never throws.
 */
async function personProducts(
  supabase: SupabaseLike,
  providers: ProviderRow[],
  org: OrgData,
  filters: DashboardFilters,
  params: PeriodParams,
  now: Date,
  planPromise: Promise<InvoicePlan>
): Promise<ProductDayRow[] | null> {
  if (drillLevel(filters) !== "detail") return null
  if (filters.provider && filters.provider !== CLAUDE_AI_SLUG) return null
  const providerId = providerIdForSlug(providers, CLAUDE_AI_SLUG)
  if (!providerId) return null
  const { start, end } = resolvePeriod(params, now)
  try {
    const [raw, identities, plan] = await Promise.all([
      fetchClaudeAiProductRows(supabase, providerId, start, end, true),
      fetchIdentities(supabase),
      planPromise,
    ])
    const rows = applyInvoicePlanToRaw(raw, plan)
    return toProductDayRows(rows, {
      filters,
      index: buildOrgIndex({ ...org, identities }),
      providerId: providerIdForSlug(providers, filters.provider),
    })
  } catch (error) {
    console.error("GET /api/dashboard/breakdown: Claude.ai product split unavailable:", error)
    return null
  }
}
