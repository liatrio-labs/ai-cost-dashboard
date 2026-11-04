/**
 * POST /api/admin/org/keys/sync — "Sync keys now" (issues #28, #32, #46) for
 * Anthropic, OpenAI and Vercel AI Gateway keys.
 *
 * Body (optional): { providers?: ("anthropic" | "openai" | "vercel-ai-gateway")[] }.
 * With no body every provider runs; a provider whose key isn't configured is
 * reported as skipped. Naming a provider that isn't configured is a 400.
 *
 * Strict: every requested provider's key list is fetched before anything is
 * written. If any key list fails (Anthropic or OpenAI Admin API, or Vercel),
 * the response is a 502 with the reason and nothing is written. Users, team
 * members, workspaces and project names stay best-effort. OpenAI also adds
 * keys seen only on its cost rows (deleted keys), best-effort.
 *
 * Response: { providers: { anthropic?: summary, openai?: summary, "vercel-ai-gateway"?: summary } }
 * where each summary has created / updated / unchanged / manual_kept /
 * unresolved_creators (the gateway summary also has creator_default_assigned,
 * issue #34) (or { status: "skipped", reason }). Manual assignments
 * are never overwritten. No key or secret is ever returned.
 */

import { z } from "zod"
import { adminRoute, HttpError, json, must, parseBody } from "@/lib/org/admin/http"
import { refreshRollups } from "@/lib/org/admin/repo"
import { applyGatewayKeySync, loadTeamMembers } from "@/lib/org/gateway-sync"
import { AnthropicKeySyncError, applyAnthropicKeySync, listAnthropicKeyData } from "@/lib/org/anthropic-key-sync"
import { OpenAIKeySyncError, applyOpenAIKeySync, listOpenAIKeyData, withCostRecordKeys } from "@/lib/org/openai-key-sync"
import { GatewayApiError, listGatewayKeysWithProjects } from "@/lib/collectors/vercel-ai-gateway"
import { PROVIDER_ENV } from "@/lib/collectors/runner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

const KEY_SYNC_PROVIDERS = ["anthropic", "openai", "vercel-ai-gateway"] as const
type SyncProvider = (typeof KEY_SYNC_PROVIDERS)[number]

const bodySchema = z
  .object({ providers: z.array(z.enum(KEY_SYNC_PROVIDERS)).min(1).optional() })
  .strict()

const LABEL: Record<SyncProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", "vercel-ai-gateway": "Vercel AI Gateway" }

function credential(provider: SyncProvider): { envName: string; value: string | undefined } {
  const envName = provider === "vercel-ai-gateway" ? "VERCEL_TOKEN" : PROVIDER_ENV[provider].apiKey
  return { envName, value: process.env[envName] || undefined }
}

export const POST = adminRoute(async (request, _params, admin) => {
  const body = await parseBody(request, bodySchema)
  const explicit = !!body.providers
  const requested = [...new Set(body.providers ?? KEY_SYNC_PROVIDERS)]

  const out: Record<string, Record<string, unknown>> = {}
  const run: SyncProvider[] = []
  for (const p of requested) {
    const { envName, value } = credential(p)
    if (value) run.push(p)
    else if (explicit) throw new HttpError(400, `${envName} is not configured, so ${LABEL[p]} keys can't be listed`)
    else out[p] = { status: "skipped", reason: `${envName} is not configured` }
  }
  if (!run.length) throw new HttpError(400, "No key sync is configured (ANTHROPIC_ADMIN_KEY, OPENAI_ADMIN_KEY or VERCEL_TOKEN)")

  const rows = must(await admin.from("providers").select("id, name").in("name", run)) as { id: string; name: string }[]
  const providerId = (p: SyncProvider) => {
    const id = rows?.find((r) => r.name === p)?.id
    if (!id) throw new HttpError(404, `Provider '${p}' not found in providers table`)
    return id
  }
  const ids = Object.fromEntries(run.map((p) => [p, providerId(p)])) as Record<SyncProvider, string>

  // 1. List every requested provider's keys before writing anything.
  let anthropicListing: Awaited<ReturnType<typeof listAnthropicKeyData>> | undefined
  let openaiListing: Awaited<ReturnType<typeof listOpenAIKeyData>> | undefined
  let gatewayKeys: Awaited<ReturnType<typeof listGatewayKeysWithProjects>> | undefined
  try {
    if (run.includes("anthropic")) anthropicListing = await listAnthropicKeyData(credential("anthropic").value!)
    if (run.includes("openai")) {
      const orgEnv = PROVIDER_ENV.openai.orgId
      openaiListing = await listOpenAIKeyData(credential("openai").value!, (orgEnv && process.env[orgEnv]) || undefined)
    }
    if (run.includes("vercel-ai-gateway")) {
      gatewayKeys = await listGatewayKeysWithProjects(credential("vercel-ai-gateway").value!, process.env.VERCEL_TEAM_ID || undefined, { strict: true })
    }
  } catch (e) {
    if (e instanceof AnthropicKeySyncError) throw new HttpError(502, `Anthropic key sync failed, nothing was changed: ${e.message}`)
    if (e instanceof OpenAIKeySyncError) throw new HttpError(502, `OpenAI key sync failed, nothing was changed: ${e.message}`)
    if (e instanceof GatewayApiError) throw new HttpError(502, `Gateway key sync failed, nothing was changed: ${e.message}`)
    throw e
  }

  // 2. Apply.
  if (anthropicListing) out.anthropic = { ...(await applyAnthropicKeySync(admin, ids.anthropic, anthropicListing)) }
  if (openaiListing) {
    // Keys seen only on cost rows (deleted keys) are added best-effort.
    out.openai = { ...(await applyOpenAIKeySync(admin, ids.openai, await withCostRecordKeys(admin, ids.openai, openaiListing))) }
  }
  if (gatewayKeys) {
    const teamId = process.env.VERCEL_TEAM_ID || undefined
    // Team members whenever any key has a creator (issue #34: the creator is every key's default owner).
    const { members, complete } = await loadTeamMembers(credential("vercel-ai-gateway").value!, teamId, gatewayKeys)
    out["vercel-ai-gateway"] = { ...(await applyGatewayKeySync(admin, ids["vercel-ai-gateway"], gatewayKeys, members, { membersComplete: complete })) }
  }
  await refreshRollups()
  return json({ providers: out })
})
