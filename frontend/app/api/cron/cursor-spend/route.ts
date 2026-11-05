/**
 * Vercel Cron endpoint: snapshot Cursor's current billing cycle (issue #76).
 *
 * POST /teams/spend only reports the current cycle, so this runs hourly
 * (vercel.json) and stores the response through migration 025. The last
 * snapshot before a cycle reset becomes that cycle's final, immutable record,
 * at most an hour old. One cheap request; it never touches cost_records.
 *
 * Without migration 025 it answers 200 with status "migration_missing" and
 * writes nothing. Without CURSOR_ADMIN_KEY it is skipped.
 */

import { NextRequest, NextResponse } from "next/server"
import { isAuthorizedCron } from "@/lib/collection"
import { createAdminClient } from "@/lib/supabase/admin"
import { snapshotCursorSpend } from "@/lib/cursor-spend"
import { PROVIDER_ENV } from "@/lib/collectors/runner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const env = PROVIDER_ENV.cursor
  const apiKey = process.env[env.apiKey]
  if (!apiKey) {
    return NextResponse.json({ success: true, result: { status: "skipped", reason: `${env.apiKey} is not configured` } })
  }
  try {
    const result = await snapshotCursorSpend(createAdminClient(), {
      apiKey,
      teamId: env.teamId ? process.env[env.teamId] : undefined,
    })
    console.log("[Cron] cursor cycle spend snapshot:", { status: result.status, cycle_start: result.cycle_start })
    return NextResponse.json({ success: result.status !== "error", result })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
