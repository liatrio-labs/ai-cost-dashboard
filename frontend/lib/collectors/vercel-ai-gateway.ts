/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Vercel AI Gateway spend collector.
 *
 * AI Gateway is billed via AI Gateway Credits — a separate path from the FOCUS
 * billing charges the `vercel` collector reads — so its model spend never shows
 * up there. This collector uses AI Gateway's Custom Reporting API instead:
 *
 *   GET https://ai-gateway.vercel.sh/v1/report
 *     ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD   (inclusive, UTC)
 *     &group_by=day&date_part=day
 *   Auth: Authorization: Bearer <AI_GATEWAY_API_KEY>  (a dedicated AI Gateway
 *   key, NOT the VERCEL_TOKEN). Pro/Enterprise only. One call covers the whole
 *   range; results can lag a few minutes.
 *
 *   Response: { results: [ {
 *     day, total_cost, market_cost, input_tokens, output_tokens,
 *     cached_input_tokens, cache_creation_input_tokens, reasoning_tokens,
 *     request_count } ] }
 *
 * Cost basis: `total_cost` — what you're actually CHARGED (USD). It returns
 * $0 for BYOK requests (those bill on the provider's own account, already
 * tracked under anthropic/openai), so using total_cost avoids double-counting
 * BYOK. `market_cost` (incl. BYOK at market rate) is kept in metadata.
 *
 * Attribution: /v1/report takes ONE group_by per request, so per-key spend is
 * pulled by repeating the daily query with `api_key_id=<id>` for each of the
 * team's AI Gateway keys (listed via GET api.vercel.com/v1/api-keys
 * ?purpose=ai-gateway, which needs the VERCEL_TOKEN, passed as ctx.auxApiKey).
 * Each day then gets one `granularity: "api_key"` row per key with spend plus
 * one `granularity: "org"` REMAINDER row = unfiltered total - sum(per-key), so
 * the day always sums to the unfiltered total. If keys can't be listed or any
 * per-key query fails, the collector emits only the org rows (remainder = the
 * whole total). Per-user attribution would need apps to send `user` and a
 * separate group_by=user query; not done here.
 *
 * Key metadata (issue #24): the key list also returns `projectId` (set when
 * the key is scoped to one project), `createdBy` (Vercel user id) and
 * `metadata.spendAttribution` ("user" | "team"; unset counts as team). Each
 * per-key row carries them in `metadata.gateway_key`, and a project-scoped
 * key's rows set `attribution.project_id` plus `project_name` from a
 * best-effort GET api.vercel.com/v9/projects/{id} (a failed lookup leaves the
 * name null and never fails collection). `api_key_id` stays the primary
 * dimension (`granularity: "api_key"`). Mapping keys to people / projects in
 * org_api_keys is the key sync's job (lib/org/gateway-sync.ts), run after
 * collection via `collector.sync`.
 *
 * model_name is "ai-gateway"; per-day UTC-midnight timestamps keep re-pulls
 * idempotent (runner delete-then-insert-by-timestamp replaces every row of a day).
 */

import type {
  Attribution,
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toFloat, toInt, isoDate, startOfUTCDay, DAY_MS } from "./http"
import { buildAttribution, orgAttribution, str } from "./attribution"
import { parseProviderTimestamp } from "@/lib/org/sync-helpers"

const REPORT_URL = "https://ai-gateway.vercel.sh/v1/report"
const API_KEYS_URL = "https://api.vercel.com/v1/api-keys"
const PROJECTS_URL = "https://api.vercel.com/v9/projects"
const MAX_PROJECT_LOOKUPS = 50
const MAX_KEYS = 200 // each key costs one report query

interface ReportRow {
  day?: string
  total_cost?: number
  market_cost?: number
  input_tokens?: number
  output_tokens?: number
  cached_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoning_tokens?: number
  request_count?: number
}

interface TransformCtx {
  userId: string
  providerId: string
  teamId?: string
}

export type SpendAttribution = "user" | "team"

export interface GatewayKey {
  id: string
  name?: string | null
  /** Vercel project id when the key is scoped to one project. */
  projectId?: string | null
  /** Resolved project name (best-effort /v9/projects lookup). */
  projectName?: string | null
  /** Vercel user id that created the key. */
  createdBy?: string | null
  /** metadata.spendAttribution; null when unset (Vercel treats unset as team). */
  spendAttribution?: SpendAttribution | null
  /** When Vercel created the key (ISO, from createdAt epoch ms) when listed; issue #44. */
  createdAt?: string | null
}

/** "user" | "team" from Vercel's metadata.spendAttribution, else null. */
export function parseSpendAttribution(value: unknown): SpendAttribution | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : ""
  return v === "user" || v === "team" ? v : null
}

/** Attribution for one key's rows: the key, plus its project when scoped. */
export function keyAttribution(key: GatewayKey): Attribution {
  return buildAttribution(
    {
      api_key_id: key.id,
      api_key_name: str(key.name),
      project_id: str(key.projectId),
      project_name: str(key.projectId) ? str(key.projectName) : null,
    },
    "api_key"
  )
}

/** metadata.gateway_key: the key's raw Vercel settings, kept for the sync and audits. */
function keyMetadata(key: GatewayKey): Record<string, unknown> {
  return {
    gateway_key: {
      project_id: str(key.projectId),
      created_by: str(key.createdBy),
      spend_attribution: key.spendAttribution ?? null,
    },
  }
}

export interface KeyReport {
  key: GatewayKey
  rows: ReportRow[]
}

const NUM_FIELDS = [
  "total_cost",
  "market_cost",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_tokens",
  "request_count",
] as const
type NumField = (typeof NUM_FIELDS)[number]
type Totals = Record<NumField, number>

function totalsOf(row: ReportRow): Totals {
  const t = {} as Totals
  for (const f of NUM_FIELDS) {
    t[f] = f === "total_cost" || f === "market_cost" ? toFloat(row?.[f]) : toInt(row?.[f] ?? 0)
  }
  return t
}

function dayIso(day: unknown): string | null {
  if (!day || typeof day !== "string") return null
  const ms = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(ms) ? null : startOfUTCDay(new Date(ms)).toISOString()
}

function toRecord(
  timestamp: string,
  t: Totals,
  ctx: TransformCtx,
  attribution: Attribution,
  extra: Record<string, unknown> = {}
): CostRecord {
  return {
    user_id: ctx.userId,
    provider_id: ctx.providerId,
    timestamp,
    model_name: "ai-gateway",
    cost_usd: t.total_cost,
    tokens_used: t.input_tokens + t.output_tokens,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    request_count: t.request_count || 1,
    collection_method: "api_automated",
    metadata: {
      provider: "vercel-ai-gateway",
      team_id: ctx.teamId ?? null,
      market_cost: t.market_cost,
      cached_input_tokens: t.cached_input_tokens,
      cache_creation_input_tokens: t.cache_creation_input_tokens,
      reasoning_tokens: t.reasoning_tokens,
      day: timestamp.slice(0, 10),
      ...extra,
      attribution,
    },
  }
}

/**
 * Transform AI Gateway daily report rows into cost_records (pure, no network).
 *
 * `rows` is the unfiltered (whole-team) daily report. With no `keyReports`
 * the result is one org row per day. With key reports, each day gets one
 * api_key row per key that had activity, plus an org remainder row (total
 * minus the per-key sum) whenever anything is left, so every day sums back to
 * the unfiltered total. Skips rows with an unparseable day.
 */
export function transform(
  rows: ReportRow[],
  ctx: TransformCtx,
  keyReports: KeyReport[] = []
): CostRecord[] {
  const records: CostRecord[] = []
  const keyed = new Map<string, Totals>() // day -> sum over keys

  for (const { key, rows: kRows } of keyReports) {
    for (const row of kRows ?? []) {
      const ts = dayIso(row?.day)
      if (!ts) continue
      const t = totalsOf(row)
      if (NUM_FIELDS.every((f) => t[f] === 0)) continue
      const sum = keyed.get(ts) ?? totalsOf({})
      for (const f of NUM_FIELDS) sum[f] += t[f]
      keyed.set(ts, sum)
      records.push(toRecord(ts, t, ctx, keyAttribution(key), keyMetadata(key)))
    }
  }

  for (const row of rows ?? []) {
    const ts = dayIso(row?.day)
    if (!ts) continue
    const total = totalsOf(row)
    const sum = keyed.get(ts)
    if (!sum) {
      records.push(toRecord(ts, total, ctx, orgAttribution()))
      continue
    }
    const rem = {} as Totals
    for (const f of NUM_FIELDS) rem[f] = total[f] - sum[f]
    if (NUM_FIELDS.every((f) => Math.abs(rem[f]) < 1e-9)) continue
    records.push(toRecord(ts, rem, ctx, orgAttribution(), { remainder: true }))
  }

  return records
}

async function fetchReport(
  apiKey: string,
  startDate: string,
  endDate: string,
  apiKeyId?: string
): Promise<ReportRow[]> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    group_by: "day",
    date_part: "day",
  })
  if (apiKeyId) params.set("api_key_id", apiKeyId)
  const res = await fetchWithRetry(`${REPORT_URL}?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    throw new Error(
      `Vercel AI Gateway report request failed: ${res.status} ${await res.text()}`
    )
  }
  const json = (await res.json()) as { results?: ReportRow[] }
  return json?.results ?? []
}

/** A Vercel API call the key sync depends on failed (issue #28). Message never includes secrets. */
export class GatewayApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GatewayApiError"
  }
}

/** Appends to `keys` as pages arrive, so a caller that catches keeps the pages already read. */
async function fetchGatewayKeys(
  vercelToken: string,
  teamId: string | undefined,
  strict: boolean,
  keys: GatewayKey[] = []
): Promise<GatewayKey[]> {
  const seen = new Set<string>()
  let until: string | null = null
  while (keys.length < MAX_KEYS) {
    const params = new URLSearchParams({ purpose: "ai-gateway", limit: "100" })
    if (teamId) params.set("teamId", teamId)
    if (until) params.set("until", until)
    let res: Response
    try {
      res = await fetchWithRetry(`${API_KEYS_URL}?${params}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${vercelToken}` },
      })
    } catch (e) {
      throw new GatewayApiError(`Vercel API key list request failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) {
      if (!strict) break
      throw new GatewayApiError(`Vercel API key list request failed: HTTP ${res.status}`)
    }
    const json: any = await res.json().catch(() => {
      throw new GatewayApiError("Vercel API key list returned invalid JSON")
    })
    const items: any[] = json?.apiKeys ?? json?.keys ?? json?.data ?? []
    let added = 0
    for (const k of items) {
      if (!k || typeof k.id !== "string" || seen.has(k.id) || keys.length >= MAX_KEYS) continue
      seen.add(k.id)
      // Optional settings are only set when present, keeping the key compact.
      const key: GatewayKey = { id: k.id, name: str(k.name) }
      const projectId = str(k.projectId)
      const createdBy = str(k.createdBy)
      const spendAttribution = parseSpendAttribution(k.metadata?.spendAttribution ?? k.spendAttribution)
      if (projectId) key.projectId = projectId
      if (createdBy) key.createdBy = createdBy
      if (spendAttribution) key.spendAttribution = spendAttribution
      const createdAt = parseProviderTimestamp(k.createdAt ?? k.created_at)
      if (createdAt) key.createdAt = createdAt
      keys.push(key)
      added++
    }
    const next = json?.pagination?.next
    // Stop when there is no cursor, or the cursor stopped producing new keys.
    if (next === null || next === undefined || added === 0) break
    until = String(next)
  }
  return keys
}

/**
 * List the team's AI Gateway keys (ids + names, never secrets) with a Vercel
 * token, following Vercel's `pagination.next` cursor (sent back as `until`) up
 * to MAX_KEYS. Never throws: a failed first page yields [], a failed later
 * page keeps the keys already listed. A partial list is still safe for
 * collection because unlisted keys' spend lands in the org remainder row.
 */
export async function listGatewayKeys(vercelToken: string, teamId?: string): Promise<GatewayKey[]> {
  const keys: GatewayKey[] = []
  try {
    await fetchGatewayKeys(vercelToken, teamId, false, keys)
  } catch {
    // keep what was listed
  }
  return keys
}

/**
 * Like listGatewayKeys, but throws GatewayApiError when any page fails. The
 * key sync uses this so a Vercel outage reports an error instead of
 * "0 keys synced" and writes nothing (issue #28).
 */
export async function listGatewayKeysStrict(vercelToken: string, teamId?: string): Promise<GatewayKey[]> {
  return fetchGatewayKeys(vercelToken, teamId, true)
}

/**
 * Best-effort project names for project-scoped keys via GET /v9/projects/{id}.
 * Never throws; a failed lookup leaves that project's name null. At most
 * MAX_PROJECT_LOOKUPS distinct projects.
 */
export async function lookupProjectNames(
  vercelToken: string,
  projectIds: string[],
  teamId?: string
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const ids = Array.from(new Set(projectIds.filter(Boolean))).slice(0, MAX_PROJECT_LOOKUPS)
  await Promise.all(
    ids.map(async (id) => {
      out.set(id, null)
      try {
        const params = new URLSearchParams()
        if (teamId) params.set("teamId", teamId)
        const qs = params.toString()
        const res = await fetchWithRetry(
          `${PROJECTS_URL}/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
          { method: "GET", headers: { Authorization: `Bearer ${vercelToken}` } },
          { maxRetries: 1, baseDelayMs: 200 }
        )
        if (!res.ok) return
        const json: any = await res.json()
        out.set(id, str(json?.name))
      } catch {
        // name stays null
      }
    })
  )
  return out
}

/**
 * List keys and attach best-effort project names. Never throws (see
 * listGatewayKeys) unless `strict`, when a failed key list throws
 * GatewayApiError (project-name lookups stay best-effort either way).
 */
export async function listGatewayKeysWithProjects(
  vercelToken: string,
  teamId?: string,
  opts: { strict?: boolean } = {}
): Promise<GatewayKey[]> {
  const keys = opts.strict ? await listGatewayKeysStrict(vercelToken, teamId) : await listGatewayKeys(vercelToken, teamId)
  const projectIds = keys.map((k) => k.projectId).filter((p): p is string => !!p)
  if (!projectIds.length) return keys
  const names = await lookupProjectNames(vercelToken, projectIds, teamId)
  return keys.map((k) => (k.projectId ? { ...k, projectName: names.get(k.projectId) ?? null } : k))
}

/**
 * Inclusive YYYY-MM-DD report dates (UTC). An explicit range [start, end)
 * (issue #28) maps to start .. end - 1 day; otherwise the daily run covers the
 * prior 2 days + today (results can lag a few minutes) and backfill the
 * requested number of days.
 */
export function reportWindow(opts: CollectOptions = {}, now: Date = new Date()): { startDate: string; endDate: string } {
  if (opts.range) {
    return { startDate: isoDate(opts.range.start), endDate: isoDate(new Date(opts.range.end.getTime() - DAY_MS)) }
  }
  const today = startOfUTCDay(now)
  const days = opts.backfill ? opts.backfillDays ?? 90 : 2
  return { startDate: isoDate(new Date(today.getTime() - days * DAY_MS)), endDate: isoDate(today) }
}

async function collect(ctx: CollectorContext, opts: CollectOptions = {}): Promise<CostRecord[]> {
  const { startDate, endDate } = reportWindow(opts)
  const tctx = { userId: ctx.userId, providerId: ctx.providerId, teamId: ctx.teamId }

  const rows = await fetchReport(ctx.apiKey, startDate, endDate)

  const keys = ctx.auxApiKey ? await listGatewayKeysWithProjects(ctx.auxApiKey, ctx.teamId) : []
  let keyReports: KeyReport[] = []
  try {
    keyReports = await Promise.all(
      keys.map(async (key) => ({ key, rows: await fetchReport(ctx.apiKey, startDate, endDate, key.id) }))
    )
  } catch (e) {
    // All-or-nothing: a partial per-key split would misattribute the remainder.
    console.warn(`[vercel-ai-gateway] per-key report failed, emitting org totals only: ${e instanceof Error ? e.message : e}`)
    keyReports = []
  }
  return transform(rows, tctx, keyReports)
}

export const collector: Collector = {
  provider: "vercel-ai-gateway",
  collect,
}
