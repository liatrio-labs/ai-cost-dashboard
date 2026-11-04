/**
 * Vercel Cron: budget and spike alerts (issue #49), daily after collection.
 * See lib/org/admin/alert-run.ts. Dry-run unless BUDGET_ALERTS_MODE=live;
 * at most one alert per subject per month (alert_log). Without migration 020
 * it does nothing and returns 200 { status: "migration_020_not_applied" }.
 */

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { runBudgetAlerts } from "@/lib/org/admin/alert-run"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const result = await runBudgetAlerts(createAdminClient())
    console.log(`[Cron] Budget alerts: ${result.status}, ${result.mode}, ${result.sent} sent/logged, ${result.deduped} deduped, ${result.failed} failed`)
    return NextResponse.json({ success: true, ...result, timestamp: new Date().toISOString() })
  } catch (error) {
    console.error("[Cron] Budget alerts failed:", error instanceof Error ? error.message : error)
    return NextResponse.json({ error: "Budget alerts failed", details: error instanceof Error ? error.message : "Unknown error" }, { status: 500 })
  }
}
