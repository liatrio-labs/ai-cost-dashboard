/**
 * Shared helper for Vercel Cron routes that trigger data collection.
 *
 * Each cron route authenticates the incoming Vercel Cron request with the
 * CRON_SECRET bearer token, then calls the Python backend's
 * POST /api/collection/run-all endpoint (also protected by CRON_SECRET) to
 * collect a provider across all active credentials.
 */

import { NextRequest, NextResponse } from "next/server"

/** Server-only backend URL, falling back to the public var and local dev. */
function getBackendUrl(): string {
  return (
    process.env.BACKEND_API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:8000"
  )
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
 * Trigger collection for a single provider across all active credentials by
 * calling the Python backend. Returns a JSON response suitable for returning
 * directly from a cron route.
 */
export async function triggerProviderCollection(
  request: NextRequest,
  provider: string,
): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const backendUrl = getBackendUrl()
  const startedAt = new Date().toISOString()
  console.log(`[Cron] ${provider} collection triggered at:`, startedAt)

  try {
    const response = await fetch(`${backendUrl}/api/collection/run-all`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ provider }),
      // Collection across all users can take a while; let the function run.
      cache: "no-store",
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      console.error(
        `[Cron] ${provider} collection failed (HTTP ${response.status}):`,
        payload,
      )
      return NextResponse.json(
        {
          success: false,
          provider,
          error: `Backend returned ${response.status}`,
          details: payload,
        },
        { status: 502 },
      )
    }

    console.log(`[Cron] ${provider} collection completed:`, {
      succeeded: payload?.succeeded,
      failed: payload?.failed,
      total_records_stored: payload?.total_records_stored,
    })

    return NextResponse.json({
      success: true,
      provider,
      triggeredAt: startedAt,
      result: payload,
    })
  } catch (error) {
    console.error(`[Cron] ${provider} collection failed:`, error)
    return NextResponse.json(
      {
        success: false,
        provider,
        error: "Collection failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
