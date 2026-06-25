/**
 * Shared helper for Vercel Cron routes that trigger data collection.
 *
 * Each cron route authenticates the incoming Vercel Cron request with the
 * CRON_SECRET bearer token, then runs collection for the provider directly
 * (in-process, via the TypeScript collectors) — no separate backend.
 */

import { NextRequest, NextResponse } from "next/server"
import { runCollectionForProvider } from "@/lib/collectors/runner"

/**
 * Verify a request came from Vercel Cron (or an authorized caller) via the
 * `Authorization: Bearer <CRON_SECRET>` header.
 */
export function isAuthorizedCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get("authorization") === `Bearer ${secret}`
}

/**
 * Run collection for a single provider and return a JSON response suitable for
 * returning directly from a cron route.
 */
export async function triggerProviderCollection(
  request: NextRequest,
  provider: string
): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = new Date().toISOString()
  // Optional manual backfill via query params: ?backfill=true&days=180
  const backfill = request.nextUrl.searchParams.get("backfill") === "true"
  const daysParam = parseInt(request.nextUrl.searchParams.get("days") || "", 10)
  const opts = backfill
    ? { backfill: true, backfillDays: Number.isFinite(daysParam) ? daysParam : 90 }
    : {}
  console.log(`[Cron] ${provider} collection triggered at:`, startedAt, opts)

  try {
    const result = await runCollectionForProvider(provider, opts)
    console.log(`[Cron] ${provider} collection:`, {
      status: result.status,
      records_stored: result.records_stored,
      reason: result.reason,
      error: result.error,
    })
    return NextResponse.json({
      success: result.status !== "error",
      provider,
      triggeredAt: startedAt,
      result,
    })
  } catch (error) {
    console.error(`[Cron] ${provider} collection failed:`, error)
    return NextResponse.json(
      {
        success: false,
        provider,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
