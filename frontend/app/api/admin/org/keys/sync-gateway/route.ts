/**
 * POST /api/admin/org/keys/sync-gateway — run the AI Gateway key sync now
 * (lib/org/gateway-sync.ts): upsert org_api_keys for every gateway key, map
 * user-attributed keys to their creator's person and project-scoped keys to
 * their project. Manual assignments are never overwritten. Also runs after
 * every vercel-ai-gateway collection. Needs VERCEL_TOKEN (and VERCEL_TEAM_ID
 * for creator emails); neither is ever returned.
 *
 * Response (issue #28): { created, updated, unchanged, manual_kept, ... } —
 * every gateway key is registered even with no spend. A failed Vercel key
 * list is a 502 with the reason, and nothing is written.
 */

import { adminRoute, HttpError, json, must } from "@/lib/org/admin/http"
import { refreshRollups } from "@/lib/org/admin/repo"
import { syncGatewayKeys } from "@/lib/org/gateway-sync"
import { GatewayApiError } from "@/lib/collectors/vercel-ai-gateway"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

export const POST = adminRoute(async (_request, _params, admin) => {
  const vercelToken = process.env.VERCEL_TOKEN
  if (!vercelToken) throw new HttpError(400, "VERCEL_TOKEN is not configured, so gateway keys can't be listed")
  const provider = must(
    await admin.from("providers").select("id").eq("name", "vercel-ai-gateway").maybeSingle()
  ) as { id: string } | null
  if (!provider) throw new HttpError(404, "Provider 'vercel-ai-gateway' not found in providers table")

  let summary
  try {
    summary = await syncGatewayKeys(admin, {
      vercelToken,
      teamId: process.env.VERCEL_TEAM_ID || undefined,
      providerId: provider.id,
    })
  } catch (e) {
    if (e instanceof GatewayApiError) throw new HttpError(502, `Gateway key sync failed, nothing was changed: ${e.message}`)
    throw e
  }
  await refreshRollups()
  return json(summary)
})
