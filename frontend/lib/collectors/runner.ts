/**
 * Environment-driven collection runner (TypeScript).
 *
 * Provider keys are org-level admin keys read from environment secrets; all
 * records are attributed to a single owner user so the dashboard is one shared
 * org-wide view. Runs in the Next.js app (cron + admin routes) — no separate
 * backend.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { createAdminClient, touchProvidersCollected } from "@/lib/supabase/admin"
import type { Collector, CostRecord, CollectionSummary, CollectOptions } from "./types"

import { collector as anthropic } from "./anthropic"
import { collector as claudeAi } from "./claude-ai"
import { collector as openai } from "./openai"
import { collector as cursor } from "./cursor"
import { collector as vercel } from "./vercel"
import { collector as apify } from "./apify"
import { collector as windsurf } from "./windsurf"
import { collector as vercelAiGateway } from "./vercel-ai-gateway"

export const COLLECTORS: Record<string, Collector> = {
  anthropic,
  "claude-ai": claudeAi,
  openai,
  cursor,
  vercel,
  apify,
  windsurf,
  "vercel-ai-gateway": vercelAiGateway,
}

/** provider -> { apiKey env, optional org/team env } */
export const PROVIDER_ENV: Record<
  string,
  { apiKey: string; orgId?: string; teamId?: string }
> = {
  anthropic: { apiKey: "ANTHROPIC_ADMIN_KEY", orgId: "ANTHROPIC_ORG_ID" },
  "claude-ai": { apiKey: "CLAUDE_AI_ANALYTICS_KEY", orgId: "CLAUDE_AI_ORG_ID" },
  openai: { apiKey: "OPENAI_ADMIN_KEY", orgId: "OPENAI_ORG_ID" },
  cursor: { apiKey: "CURSOR_ADMIN_KEY", teamId: "CURSOR_TEAM_ID" },
  vercel: { apiKey: "VERCEL_TOKEN", teamId: "VERCEL_TEAM_ID" },
  apify: { apiKey: "APIFY_TOKEN" },
  windsurf: { apiKey: "WINDSURF_SERVICE_KEY", teamId: "WINDSURF_TEAM_ID" },
  "vercel-ai-gateway": { apiKey: "AI_GATEWAY_API_KEY", teamId: "VERCEL_TEAM_ID" },
}

const DEFAULT_OWNER_EMAIL = "robert@liatrio.com"
let ownerCache: string | null = null

/** Resolve the single owner user id (env override, else by email). Cached. */
export async function getOwnerUserId(admin: SupabaseClient): Promise<string> {
  if (ownerCache) return ownerCache
  const explicit = process.env.DASHBOARD_OWNER_USER_ID
  if (explicit) {
    ownerCache = explicit
    return explicit
  }
  const email = (process.env.DASHBOARD_OWNER_EMAIL || DEFAULT_OWNER_EMAIL).toLowerCase()
  const { data, error } = await admin.auth.admin.listUsers()
  if (error) throw new Error(`Could not list users: ${error.message}`)
  const user = data.users.find((u) => u.email?.toLowerCase() === email)
  if (!user) {
    throw new Error(
      `Could not resolve owner user id for '${email}'. Set DASHBOARD_OWNER_USER_ID, or ensure that user has logged in.`
    )
  }
  ownerCache = user.id
  return user.id
}

async function storeRecords(admin: SupabaseClient, records: CostRecord[]): Promise<number> {
  if (!records.length) return 0

  // Idempotency: a re-run of the same window must not double-count. Delete the
  // existing automated rows for this provider/owner at the exact bucket
  // timestamps we're about to insert, then insert fresh. Manual/CSV rows
  // (other collection_methods) are left untouched.
  const providerId = records[0].provider_id
  const userId = records[0].user_id
  const timestamps = Array.from(new Set(records.map((r) => r.timestamp)))
  for (let i = 0; i < timestamps.length; i += 100) {
    const chunk = timestamps.slice(i, i + 100)
    const { error: delErr } = await admin
      .from("cost_records")
      .delete()
      .eq("provider_id", providerId)
      .eq("user_id", userId)
      .eq("collection_method", "api_automated")
      .in("timestamp", chunk)
    if (delErr) throw new Error(`Failed to clear prior cost_records: ${delErr.message}`)
  }

  const { data, error } = await admin.from("cost_records").insert(records).select("id")
  if (error) throw new Error(`Failed to insert cost_records: ${error.message}`)
  return data?.length ?? 0
}

/**
 * Collect a single provider using its env-configured key, attributing records
 * to the owner user. Never throws for operational errors — returns a summary.
 */
export async function runCollectionForProvider(
  provider: string,
  opts: CollectOptions = {}
): Promise<CollectionSummary> {
  const timestamp = new Date().toISOString()
  const collector = COLLECTORS[provider]
  if (!collector) {
    return {
      status: "error",
      provider,
      error: `Unsupported provider. Supported: ${Object.keys(COLLECTORS).join(", ")}`,
      timestamp,
    }
  }

  const envCfg = PROVIDER_ENV[provider]
  const apiKey = process.env[envCfg.apiKey]
  if (!apiKey) {
    return {
      status: "skipped",
      provider,
      reason: `${envCfg.apiKey} is not configured`,
      records_stored: 0,
      timestamp,
    }
  }

  try {
    const admin = createAdminClient()
    const { data: prov, error: provErr } = await admin
      .from("providers")
      .select("id")
      .eq("name", provider)
      .single()
    if (provErr || !prov) {
      return {
        status: "error",
        provider,
        error: `Provider '${provider}' not found in providers table`,
        timestamp,
      }
    }

    const ownerUserId = await getOwnerUserId(admin)
    const records = await collector.collect(
      {
        apiKey,
        userId: ownerUserId,
        providerId: (prov as { id: string }).id,
        organizationId: envCfg.orgId ? process.env[envCfg.orgId] : undefined,
        teamId: envCfg.teamId ? process.env[envCfg.teamId] : undefined,
      },
      opts
    )
    const stored = await storeRecords(admin, records)

    // Stamp the tool's "Last updated" time on every successful pull.
    await touchProvidersCollected([(prov as { id: string }).id])

    return {
      status: "success",
      provider,
      records_collected: records.length,
      records_stored: stored,
      owner_user_id: ownerUserId,
      timestamp,
    }
  } catch (e) {
    return {
      status: "error",
      provider,
      error: e instanceof Error ? e.message : String(e),
      timestamp,
    }
  }
}
