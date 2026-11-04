/**
 * Per-provider sync freshness (issue #47).
 *
 * GET /api/dashboard/freshness
 * -> { asOf, providers: ProviderFreshness[] }
 *
 * Reads providers.last_collected_at (migration 008) and, for manual providers,
 * whether cost_records_daily has any row in the current America/Chicago month.
 * Cron schedules come from vercel.json. The state logic is in
 * lib/sync-freshness.ts. Admin only (issue #57): 401 when logged out, 403 for
 * non-admins, same requireAdmin check as the /api/admin routes. Used by the
 * admin page.
 */

import { cookies } from "next/headers"
import { createClient, requireAdmin, errorResponse, successResponse } from "@/lib/db"
import { chicagoMonthAndDay, computeFreshness, isManualProvider, type CronEntry, type FreshnessProvider } from "@/lib/sync-freshness"
import vercelConfig from "@/vercel.json"

export const dynamic = "force-dynamic"

const CRONS: CronEntry[] = (vercelConfig as { crons?: CronEntry[] }).crons ?? []

function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`
}

export async function GET() {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)
    const supabase = await createClient(cookieStore)

    const { data, error } = await supabase
      .from("providers")
      .select("id, name, display_name, last_collected_at, metadata, is_active")
      .order("display_name")
    if (error) throw error
    const providers = ((data || []) as (FreshnessProvider & { is_active?: boolean | null })[]).filter(
      (p) => p.is_active !== false
    )

    const now = new Date()
    const { month } = chicagoMonthAndDay(now)
    const manualIds = providers.filter(isManualProvider).map((p) => p.id)
    const withEntry = new Set<string>()
    // One existence check per manual provider (there are few). Monthly entries
    // are stamped YYYY-MM-01T12:00Z, so a UTC-day window on the CT month is safe.
    const checks = await Promise.all(
      manualIds.map((id) =>
        supabase
          .from("cost_records_daily")
          .select("provider_id")
          .eq("provider_id", id)
          .gte("date", `${month}-01`)
          .lt("date", `${nextMonth(month)}-01`)
          .limit(1)
      )
    )
    checks.forEach((r, i) => {
      if (r.error) throw r.error
      if (r.data?.length) withEntry.add(manualIds[i])
    })

    return successResponse({
      asOf: now.toISOString(),
      providers: computeFreshness({ providers, crons: CRONS, manualEntryThisMonth: withEntry }, { now }),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (message === "Forbidden") return errorResponse("Forbidden", 403)
    console.error("GET /api/dashboard/freshness error:", error)
    return errorResponse(message || "Failed to load sync freshness", 500)
  }
}
