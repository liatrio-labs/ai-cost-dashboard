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

const REPORT_URL = "https://ai-gateway.vercel.sh/v1/report"
const API_KEYS_URL = "https://api.vercel.com/v1/api-keys"
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

export interface GatewayKey {
  id: string
  name?: string | null
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
      records.push(
        toRecord(ts, t, ctx, buildAttribution({ api_key_id: key.id, api_key_name: str(key.name) }, "api_key"))
      )
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

/**
 * List the team's AI Gateway keys (ids + names, never secrets) with a Vercel
 * token. Returns [] on any failure.
 */
export async function listGatewayKeys(vercelToken: string, teamId?: string): Promise<GatewayKey[]> {
  try {
    const params = new URLSearchParams({ purpose: "ai-gateway", limit: "100" })
    if (teamId) params.set("teamId", teamId)
    const res = await fetchWithRetry(`${API_KEYS_URL}?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${vercelToken}` },
    })
    if (!res.ok) return []
    const json: any = await res.json()
    const items: any[] = json?.apiKeys ?? json?.keys ?? json?.data ?? []
    return items
      .filter((k) => k && typeof k.id === "string")
      .slice(0, MAX_KEYS)
      .map((k) => ({ id: k.id, name: str(k.name) }))
  } catch {
    return []
  }
}

async function collect(ctx: CollectorContext, opts: CollectOptions = {}): Promise<CostRecord[]> {
  const today = startOfUTCDay(new Date())
  // Daily run: cover the prior 2 days + today (results can lag a few minutes);
  // backfill: the requested window. Dates are inclusive YYYY-MM-DD in UTC.
  const days = opts.backfill ? opts.backfillDays ?? 90 : 2
  const startDate = isoDate(new Date(today.getTime() - days * DAY_MS))
  const endDate = isoDate(today)
  const tctx = { userId: ctx.userId, providerId: ctx.providerId, teamId: ctx.teamId }

  const rows = await fetchReport(ctx.apiKey, startDate, endDate)

  const keys = ctx.auxApiKey ? await listGatewayKeys(ctx.auxApiKey, ctx.teamId) : []
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
