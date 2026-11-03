/**
 * Shared helper for Vercel Cron routes that trigger data collection.
 *
 * Each cron route authenticates the incoming Vercel Cron request with the
 * CRON_SECRET bearer token, then runs collection for the provider directly
 * (in-process, via the TypeScript collectors) — no separate backend.
 */

import { createHash, timingSafeEqual } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { runCollectionForProvider } from "@/lib/collectors/runner"
import { describeRange, resolveDateRange } from "@/lib/collectors/date-range"
import type { CollectOptions } from "@/lib/collectors/types"

/** Constant-time string compare (hash both sides so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest()
  const hb = createHash("sha256").update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** The bearer token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization")
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : null
}

/**
 * `Authorization: Bearer <COLLECTION_TRIGGER_SECRET>` for operator-run
 * collection (e.g. chunked re-pulls with curl). Disabled when the env var is
 * unset or empty.
 */
export function isAuthorizedTrigger(request: NextRequest): boolean {
  const secret = process.env.COLLECTION_TRIGGER_SECRET
  if (!secret) return false
  const token = bearerToken(request)
  return token !== null && safeEqual(token, secret)
}

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
  const params = request.nextUrl.searchParams
  // Optional explicit range: ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD (same
  // validator as /api/admin/collect). Takes precedence over backfill.
  const parsed = resolveDateRange(provider, params.get("start_date"), params.get("end_date"))
  if (!parsed.ok) {
    return NextResponse.json({ success: false, provider, error: parsed.error }, { status: 400 })
  }
  const range = parsed.range
  // Optional manual backfill via query params: ?backfill=true&days=180
  const backfill = params.get("backfill") === "true"
  const daysParam = parseInt(params.get("days") || "", 10)
  const opts: CollectOptions = range
    ? { range: { start: range.start, end: range.end } }
    : backfill
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
      ...(range ? { range: describeRange(range) } : {}),
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
