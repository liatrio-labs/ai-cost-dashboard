/**
 * GET /api/dashboard/cursor-cycle: Cursor billing-cycle on-demand spend
 * (issue #76), from the /teams/spend snapshots in migration 025.
 *
 * Returns lib/cursor-spend.ts CursorCycleView: the current cycle (dates,
 * team on-demand total = sum of members' spendCents, per-member spend and
 * limits) and earlier cycles' final snapshots. Billing-cycle figures only;
 * the calendar-month totals in /api/dashboard are unaffected.
 *
 * Without migration 025 it answers 200 with { available: false, notice }.
 */

import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import { readCursorCycleSpend, type ReadClient } from "@/lib/cursor-spend"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore) // same gate as /api/dashboard
    const supabase = (await createClient(cookieStore)) as unknown as ReadClient
    return successResponse(await readCursorCycleSpend(supabase))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard/cursor-cycle error:", error)
    return errorResponse(message || "Failed to load Cursor billing cycle", 500)
  }
}
