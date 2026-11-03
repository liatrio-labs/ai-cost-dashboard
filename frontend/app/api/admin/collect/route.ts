/**
 * Owner-only manual collection trigger.
 *
 * POST /api/admin/collect
 *   { provider, backfill?, backfill_days? }            trailing window (unchanged)
 *   { provider, start_date, end_date }                  explicit range (issue #20)
 *
 * start_date / end_date are ISO YYYY-MM-DD UTC days, end_date inclusive, span
 * <= 31 days, for anthropic, claude-ai and openai (see lib/collectors/date-range).
 * A range takes precedence over backfill.
 *
 * Auth: an admin session (requireAdmin), or
 * `Authorization: Bearer <COLLECTION_TRIGGER_SECRET>` for operator scripts
 * (disabled when that env var is unset or empty). Runs collection in-process
 * via the TypeScript collectors (no separate backend).
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { requireAdmin, errorResponse, successResponse } from "@/lib/db"
import { runCollectionForProvider, COLLECTORS } from "@/lib/collectors/runner"
import { describeRange, resolveDateRange } from "@/lib/collectors/date-range"
import { bearerToken, isAuthorizedTrigger } from "@/lib/collection"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    if (!isAuthorizedTrigger(request)) {
      // A bearer token that doesn't match is rejected outright; without one,
      // fall back to the admin session.
      if (bearerToken(request) !== null) return errorResponse("Unauthorized", 401)
      const cookieStore = await cookies()
      await requireAdmin(cookieStore)
    }

    const body = await request.json().catch(() => ({}))
    const provider = body?.provider
    if (!provider || !(provider in COLLECTORS)) {
      return errorResponse(
        `Invalid provider. One of: ${Object.keys(COLLECTORS).join(", ")}`,
        400
      )
    }

    const parsed = resolveDateRange(provider, body.start_date, body.end_date)
    if (!parsed.ok) return errorResponse(parsed.error, 400)
    const range = parsed.range

    const result = await runCollectionForProvider(
      provider,
      range
        ? { range: { start: range.start, end: range.end } }
        : { backfill: !!body.backfill, backfillDays: body.backfill_days ?? 90 }
    )
    // Refresh the dashboard rollup so pulled data shows immediately.
    if (result.status === "success") await refreshDailyAggregates()
    return successResponse(range ? { ...result, range: describeRange(range) } : result)
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : undefined
    if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (message === "Forbidden") return errorResponse("Forbidden", 403)
    console.error("POST /api/admin/collect error:", e)
    return errorResponse(message || "Failed to trigger collection", 500)
  }
}
