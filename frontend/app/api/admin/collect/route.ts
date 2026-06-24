/**
 * Owner-only manual collection trigger.
 *
 * POST /api/admin/collect  { provider, backfill?, backfill_days? }
 *
 * Gated to admin/owner users (see requireAdmin). Proxies to the Python backend's
 * /api/collection/run-all with the server-side trigger secret, so the secret is
 * never exposed to the browser.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { requireAdmin, errorResponse, successResponse } from "@/lib/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const PROVIDERS = ["anthropic", "claude-ai", "openai", "cursor", "vercel"]

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)

    const body = await request.json().catch(() => ({}))
    const provider = body.provider
    if (!PROVIDERS.includes(provider)) {
      return errorResponse(`Invalid provider. One of: ${PROVIDERS.join(", ")}`, 400)
    }

    const backendUrl = process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_API_URL
    const secret = process.env.COLLECTION_TRIGGER_SECRET || process.env.CRON_SECRET
    if (!backendUrl) return errorResponse("BACKEND_API_URL is not configured", 500)
    if (!secret) return errorResponse("Collection trigger secret is not configured", 500)

    const res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/collection/run-all`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        provider,
        backfill: !!body.backfill,
        backfill_days: body.backfill_days ?? 90,
      }),
      cache: "no-store",
    })

    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      return errorResponse(payload?.error || `Backend returned ${res.status}`, 502)
    }
    return successResponse(payload)
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    console.error("POST /api/admin/collect error:", e)
    return errorResponse(e?.message || "Failed to trigger collection", 500)
  }
}
