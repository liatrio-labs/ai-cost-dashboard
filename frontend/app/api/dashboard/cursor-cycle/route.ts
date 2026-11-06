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
import type { SupabaseLike } from "@/lib/dashboard-data"
import { loadCursorCycle } from "@/lib/dashboard-service"

export const dynamic = "force-dynamic"

// The read model lives in lib/dashboard-service.ts, shared with the MCP server (issue #94).
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore) // shared org-wide view; gate on login only
    // Typed client -> the minimal shape lib/dashboard-data.ts needs (see SupabaseLike).
    const supabase = (await createClient(cookieStore)) as unknown as SupabaseLike
    return successResponse(await loadCursorCycle(supabase, request.nextUrl.searchParams))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard/cursor-cycle error:", error)
    return errorResponse(message || "Failed to load Cursor billing cycle", 500)
  }
}
