/**
 * GET /api/dashboard/cursor-cycle: Cursor billing-cycle on-demand spend
 * (issue #76), from the /teams/spend snapshots in migration 025.
 *
 * Returns lib/cursor-cycle-scope.ts ScopedCursorCycleView: the current cycle
 * (dates, last snapshot time, team on-demand total = sum of members'
 * spendCents, per-member spend and limits) and earlier cycles' final
 * snapshots. Billing-cycle figures only; the calendar-month totals in
 * /api/dashboard are unaffected.
 *
 * Issue #84: optional filters (department, team, person, key, project,
 * provider; the same params as /api/dashboard, period ignored) scope the
 * current cycle's members. Members match people by normalized email /
 * Cursor identity like Cursor usage events do, never by display name. A
 * filter that can't apply to a per-member snapshot answers with
 * scope.kind "not_applicable" and a reason.
 *
 * Without migration 025 it answers 200 with { available: false, notice }.
 * Any other failure is a 500 with the error message, which the dashboard
 * shows in place of the card.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import { readCursorCycleSpend, type ReadClient } from "@/lib/cursor-spend"
import { parseFilters } from "@/lib/dashboard-filters"
import { fetchIdentities, fetchOrgData, fetchProviders, providerIdForSlug, type SupabaseLike } from "@/lib/dashboard-data"
import {
  CURSOR_PROVIDER_SLUG,
  cycleScopeBlocker,
  isScopedCycleRequest,
  scopeCursorCycleView,
} from "@/lib/cursor-cycle-scope"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore) // same gate as /api/dashboard
    const client = await createClient(cookieStore)
    const filters = parseFilters(request.nextUrl.searchParams)
    const view = await readCursorCycleSpend(client as unknown as ReadClient)

    // Org data only when an org filter will actually narrow the members.
    const needsOrg = view.available && !!view.current && isScopedCycleRequest(filters) && !cycleScopeBlocker(filters)
    let org = null
    let cursorProviderId: string | null = null
    if (needsOrg) {
      const supabase = client as unknown as SupabaseLike
      const [providers, orgData, identities] = await Promise.all([
        fetchProviders(supabase),
        fetchOrgData(supabase),
        fetchIdentities(supabase),
      ])
      cursorProviderId = providerIdForSlug(providers, CURSOR_PROVIDER_SLUG)
      // Cursor identities only: the same lookup Cursor usage events get.
      org = { ...orgData, identities: identities.filter((i) => i.provider_id === cursorProviderId) }
    }
    return successResponse(scopeCursorCycleView(view, filters, { org, cursorProviderId }))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard/cursor-cycle error:", error)
    return errorResponse(message || "Failed to load Cursor billing cycle", 500)
  }
}
