/**
 * Vercel Cron endpoint for refreshing the cost_records_daily materialized view.
 * Triggered every 15 minutes by Vercel Cron Jobs.
 */

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    console.log("[Cron] Refreshing aggregates at:", new Date().toISOString())
    const supabase = createAdminClient()
    const { error } = await supabase.rpc("refresh_cost_records_daily")
    if (error) throw error

    return NextResponse.json({
      success: true,
      message: "Aggregates refreshed successfully",
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[Cron] Aggregate refresh failed:", error)
    return NextResponse.json(
      { error: "Refresh failed", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
