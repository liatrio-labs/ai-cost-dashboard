/**
 * Owner-only manual collection trigger.
 *
 * POST /api/admin/collect  { provider, backfill?, backfill_days? }
 *
 * Gated to admin/owner users. Runs collection in-process via the TypeScript
 * collectors (no separate backend).
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { requireAdmin, errorResponse, successResponse } from "@/lib/db"
import { runCollectionForProvider, COLLECTORS } from "@/lib/collectors/runner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)

    const body = await request.json().catch(() => ({}))
    const provider = body.provider
    if (!provider || !(provider in COLLECTORS)) {
      return errorResponse(
        `Invalid provider. One of: ${Object.keys(COLLECTORS).join(", ")}`,
        400
      )
    }

    const result = await runCollectionForProvider(provider, {
      backfill: !!body.backfill,
      backfillDays: body.backfill_days ?? 90,
    })
    return successResponse(result)
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    console.error("POST /api/admin/collect error:", e)
    return errorResponse(e?.message || "Failed to trigger collection", 500)
  }
}
