/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Anthropic Admin API data collector (platform.claude.com / developer API).
 *
 * PRIMARY: Usage & Cost Analytics API (beta, see ./anthropic-analytics)
 *   GET /v1/organizations/analytics/cost and /analytics/usage
 *   group_by[]=actor,api_key_id,workspace_id,model, time_bucket_width=1d
 *   -> one row per (day x actor x api key x workspace x model) with
 *      metadata.attribution (person / api_key / workspace / org).
 *
 * FALLBACK (analytics returns 403/404): the legacy reports
 *   GET /v1/organizations/cost_report           group_by[]=workspace_id
 *   GET /v1/organizations/usage_report/messages group_by[]=workspace_id
 *   -> one row per (day x workspace), attribution "workspace" (or "org" for the
 *      default workspace, whose workspace_id is null).
 *
 * Requires an Admin API key (sk-ant-admin...). Analytics data refreshes within
 * 4-24h and keeps settling for days after a UTC day ends, so a daily
 * (non-backfill) pull re-fetches today plus the prior DEFAULT_LOOKBACK_DAYS (7)
 * UTC days, i.e. [today - 7d, tomorrow). storeRecords() replaces every
 * api_automated row at a re-fetched timestamp, so late revisions (up or down)
 * overwrite what an earlier run captured.
 */

import type { Collector, CostRecord, CollectorContext, CollectOptions } from "./types"
import { fetchWithRetry, toFloat, toInt, rfc3339, startOfUTCDay, DAY_MS, sleep } from "./http"
import { buildAttribution, str } from "./attribution"
import {
  AnalyticsUnavailableError,
  actorMetadata,
  bucketIso,
  fetchAnalytics,
  groupAttribution,
  rowKey,
  safeInt,
  sumInputTokens,
  MIN_DATA_MS,
  type AnalyticsRow,
} from "./anthropic-analytics"

const ADMIN_API_BASE_URL = "https://api.anthropic.com/v1/organizations"
const ANTHROPIC_VERSION = "2023-06-01"
const RATE_LIMIT_DELAY_MS = 1000 // delay between paginated requests
/**
 * Daily (non-backfill) pull: today plus this many prior UTC days. Usage keeps
 * settling after a day ends; a 7-day window lets late revisions land (#21).
 */
export const DEFAULT_LOOKBACK_DAYS = 7
export const ANALYTICS_GROUP_BY = ["actor", "api_key_id", "workspace_id", "model"]
const SEP = "\u0000"

interface Ctx {
  userId: string
  providerId: string
  organizationId?: string
}

/**
 * Legacy usage_report rows: sum uncached + cache creation + cache read, or a
 * plain input_tokens field when present.
 */
function legacyInputTokens(row: Record<string, any>): number {
  if (row.input_tokens !== undefined && row.input_tokens !== null) {
    return toInt(row.input_tokens)
  }
  let total = 0
  for (const field of ["uncached_input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    total += toInt(row[field] ?? 0)
  }
  return total
}

interface UsageAgg {
  input: number
  output: number
  requests: number
}

/**
 * LEGACY transform: cost_report + usage_report buckets -> cost_records.
 *
 * Merges by (bucket starting_at, workspace_id, model): usage rows contribute
 * tokens/requests, cost rows contribute USD (`amount` is CENTS). One record per
 * key seen in either report.
 */
export function transform(
  usageBuckets: any[],
  costBuckets: any[],
  ctx: Ctx,
  bucketWidth: string = "1d"
): CostRecord[] {
  const keyOf = (start: unknown, row: any) =>
    [start, row?.workspace_id ?? "", row?.model || "unknown"].join(SEP)

  const costMap = new Map<string, number>()
  for (const bucket of costBuckets || []) {
    for (const row of bucket?.results || []) {
      const key = keyOf(bucket?.starting_at, row)
      costMap.set(key, (costMap.get(key) ?? 0) + toFloat(row?.amount) / 100)
    }
  }

  const usageMap = new Map<string, UsageAgg>()
  for (const bucket of usageBuckets || []) {
    for (const row of bucket?.results || []) {
      const key = keyOf(bucket?.starting_at, row)
      const agg = usageMap.get(key) ?? { input: 0, output: 0, requests: 0 }
      agg.input += legacyInputTokens(row)
      agg.output += toInt(row?.output_tokens ?? 0)
      agg.requests += toInt(row?.request_count ?? 0)
      usageMap.set(key, agg)
    }
  }

  const records: CostRecord[] = []
  for (const key of new Set([...costMap.keys(), ...usageMap.keys()])) {
    const [bucketStart, workspaceId, model] = key.split(SEP)
    const timestamp = bucketIso(bucketStart)
    if (timestamp === null) continue

    const usage = usageMap.get(key) ?? { input: 0, output: 0, requests: 0 }
    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp,
      model_name: model,
      cost_usd: costMap.get(key) ?? 0,
      tokens_used: usage.input + usage.output,
      input_tokens: usage.input,
      output_tokens: usage.output,
      request_count: usage.requests || 1,
      collection_method: "api_automated",
      metadata: {
        provider: "anthropic",
        bucket_width: bucketWidth,
        organization_id: ctx.organizationId,
        source: "cost_report",
        attribution: buildAttribution({ workspace_id: str(workspaceId) }),
      },
    })
  }
  return records
}

/**
 * ANALYTICS transform: /analytics/cost + /analytics/usage rows -> cost_records.
 *
 * Joins cost and usage by (bucket, full group); one record per group seen in
 * either response. `amount` is cents (decimal string).
 */
export function transformAnalytics(
  costRows: AnalyticsRow[],
  usageRows: AnalyticsRow[],
  ctx: Ctx,
  bucketWidth: string = "1d"
): CostRecord[] {
  interface Merged {
    row: AnalyticsRow
    cost?: { amountCents: number; listCents: number | null; requests: number | null }
    usage?: Record<string, any>
  }
  const merged = new Map<string, Merged>()
  const add = (row: AnalyticsRow, field: "cost" | "usage") => {
    if (!row || typeof row !== "object") return
    const key = rowKey(row)
    const entry: Merged = merged.get(key) ?? { row }
    if (field === "cost") {
      // One row per group is expected; sum defensively if a group repeats.
      const c = row.cost ?? {}
      const prev = entry.cost
      const list = c.list_amount != null ? toFloat(c.list_amount) : null
      const req = safeInt(c.requests)
      entry.cost = {
        amountCents: (prev?.amountCents ?? 0) + toFloat(c.amount),
        listCents: list === null && prev?.listCents == null ? null : (prev?.listCents ?? 0) + (list ?? 0),
        requests: req === null && prev?.requests == null ? null : (prev?.requests ?? 0) + (req ?? 0),
      }
    } else {
      entry.usage = row.usage ?? {}
    }
    merged.set(key, entry)
  }
  for (const r of costRows || []) add(r, "cost")
  for (const r of usageRows || []) add(r, "usage")

  const records: CostRecord[] = []
  for (const { row, cost, usage } of merged.values()) {
    const timestamp = bucketIso(row.starting_at)
    if (timestamp === null) continue
    const group = row.group ?? {}
    const input = sumInputTokens(usage) ?? 0
    const output = safeInt(usage?.output_tokens) ?? 0
    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp,
      model_name: str(group.model) ?? "unknown",
      cost_usd: cost ? cost.amountCents / 100 : 0,
      tokens_used: input + output,
      input_tokens: input,
      output_tokens: output,
      request_count: safeInt(usage?.requests) || safeInt(cost?.requests) || 1,
      collection_method: "api_automated",
      metadata: {
        provider: "anthropic",
        bucket_width: bucketWidth,
        organization_id: ctx.organizationId,
        source: "analytics",
        list_amount_usd: cost?.listCents != null ? cost.listCents / 100 : null,
        ...actorMetadata(group),
        attribution: groupAttribution(group),
      },
    })
  }
  return records
}

/** Fetch all time-bucket rows from a paginated legacy Admin API report. */
async function fetchLegacyPaginated(
  apiKey: string,
  endpoint: string,
  startTime: Date,
  endTime: Date,
  bucketWidth: string,
  groupBy: string[]
): Promise<any[]> {
  const allBuckets: any[] = []
  let page: string | undefined

  while (true) {
    const params = new URLSearchParams({
      starting_at: rfc3339(startTime),
      ending_at: rfc3339(endTime),
      bucket_width: bucketWidth,
    })
    for (const g of groupBy) params.append("group_by[]", g)
    if (page) params.set("page", page)

    const res = await fetchWithRetry(`${ADMIN_API_BASE_URL}${endpoint}?${params}`, {
      method: "GET",
      headers: { "anthropic-version": ANTHROPIC_VERSION, "x-api-key": apiKey },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`Anthropic Admin API request failed: ${res.status} ${endpoint} - ${body}`)
    }
    const data = (await res.json()) as { data?: any[]; has_more?: boolean; next_page?: string | null }
    allBuckets.push(...(data.data || []))
    page = data.next_page ?? undefined
    if (!data.has_more || !page) break
    await sleep(RATE_LIMIT_DELAY_MS)
  }
  return allBuckets
}

/**
 * Collect from the Analytics API (today + prior DEFAULT_LOOKBACK_DAYS days, or `backfillDays`
 * with backfill), falling back to the legacy reports on 403/404.
 */
async function collect(ctx: CollectorContext, opts: CollectOptions = {}): Promise<CostRecord[]> {
  const bucketWidth = "1d"
  const today = startOfUTCDay(new Date())
  const days = opts.backfill ? opts.backfillDays ?? 90 : DEFAULT_LOOKBACK_DAYS
  const startTime = new Date(today.getTime() - days * DAY_MS)
  const endTime = new Date(today.getTime() + DAY_MS)
  const tctx = { userId: ctx.userId, providerId: ctx.providerId, organizationId: ctx.organizationId }

  try {
    const analyticsStart = new Date(Math.max(startTime.getTime(), MIN_DATA_MS))
    const { cost, usage } = await fetchAnalytics(ctx.apiKey, analyticsStart, endTime, ANALYTICS_GROUP_BY)
    return transformAnalytics(cost, usage, tctx, bucketWidth)
  } catch (e) {
    if (!(e instanceof AnalyticsUnavailableError)) throw e
    console.warn(`[anthropic] ${e.message}; falling back to legacy cost_report`)
  }

  const [usageBuckets, costBuckets] = await Promise.all([
    fetchLegacyPaginated(ctx.apiKey, "/usage_report/messages", startTime, endTime, bucketWidth, ["workspace_id"]),
    fetchLegacyPaginated(ctx.apiKey, "/cost_report", startTime, endTime, bucketWidth, ["workspace_id"]),
  ])
  return transform(usageBuckets, costBuckets, tctx, bucketWidth)
}

export const collector: Collector = { provider: "anthropic", collect }
