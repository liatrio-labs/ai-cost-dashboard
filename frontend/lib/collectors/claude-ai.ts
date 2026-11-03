/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Claude Enterprise Analytics collector (claude.ai / Claude for Work surface).
 *
 * PRIMARY: Usage & Cost Analytics API (beta, see ./anthropic-analytics)
 *   GET /v1/organizations/analytics/cost and /analytics/usage
 *   group_by[]=actor,model,product, time_bucket_width=1d, limit=1000
 *   Returns EVERY group (the legacy cost_report caps at the top 100 per bucket),
 *   so per-person rows sum to the org total. Actor email -> person_email.
 *
 * FALLBACK (analytics returns 403/404): the legacy
 *   /v1/organizations/analytics/cost_report + /usage_report grouped by model,
 *   attributed "org" (no per-person dimension there).
 *
 * Requires an API key with the `read:analytics` scope. Amounts are cents.
 *
 * Daily pulls re-fetch today plus the prior DEFAULT_LOOKBACK_DAYS (30) UTC
 * days (31 buckets): Claude.ai totals stay revisable for ~30 days, and a short
 * window would freeze undercounts that no longer match the admin site (PR #2).
 */

import type { Collector, CostRecord, CollectorContext, CollectOptions } from "./types"
import { fetchWithRetry, toFloat, rfc3339, startOfUTCDay, DAY_MS } from "./http"
import { orgAttribution, str } from "./attribution"
import {
  AnalyticsUnavailableError,
  actorMetadata,
  bucketIso,
  fetchAnalytics,
  groupAttribution,
  iterChunks,
  rowKey,
  safeInt,
  sumInputTokens,
  MAX_SPAN_DAYS,
  MIN_DATA_MS,
  type AnalyticsRow,
} from "./anthropic-analytics"

const LEGACY_BASE_URL = "https://api.anthropic.com/v1/organizations/analytics"
const ANTHROPIC_VERSION = "2023-06-01"
// `amount` / `list_amount` are returned in fractional cents.
const CENTS_PER_USD = 100.0
// Legacy 1d pages default to 7 buckets if `limit` is omitted.
const PAGE_LIMIT_1D = 31
// Restart pagination this many times if a cursor expires (HTTP 410).
const MAX_PAGINATION_RESTARTS = 3
/** Daily (non-backfill) pull: today plus this many prior UTC days (= 31 buckets). */
export const DEFAULT_LOOKBACK_DAYS = 30
export const ANALYTICS_GROUP_BY = ["actor", "model", "product"]

/** Build a join key matching cost and usage results within a bucket. */
function resultKey(startingAt: string | null | undefined, result: any): string {
  return JSON.stringify([
    startingAt ?? null,
    result?.model ?? null,
    result?.product ?? null,
  ])
}

/**
 * LEGACY transform: cost_report + usage_report buckets -> cost_records rows.
 *
 * Cost is the source of truth for emitted rows (one record per cost result);
 * usage results are joined in by (bucket start, model, product) to attach token
 * counts. Defensive throughout: unparseable buckets and results are skipped
 * rather than raising.
 */
export function transform(
  costBuckets: any[],
  usageBuckets: any[],
  ctx: { userId: string; providerId: string; organizationId?: string },
  bucketWidth: string = "1d"
): CostRecord[] {
  // Build a lookup of usage results keyed by (start, model, product).
  const usageMap = new Map<string, any>()
  for (const bucket of usageBuckets || []) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue
    const startingAt = bucket.starting_at
    for (const result of bucket.results || []) {
      if (!result || typeof result !== "object" || Array.isArray(result)) continue
      usageMap.set(resultKey(startingAt, result), result)
    }
  }

  const records: CostRecord[] = []

  for (const bucket of costBuckets || []) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue
    const startingAt = bucket.starting_at
    if (!startingAt) {
      // Skip cost bucket with no starting_at.
      continue
    }

    // Parse the bucket start timestamp once, guaranteeing tz-awareness.
    let timestampIso: string
    try {
      const parsed = new Date(String(startingAt))
      if (Number.isNaN(parsed.getTime())) throw new Error("invalid date")
      timestampIso = parsed.toISOString()
    } catch {
      // Failed to parse bucket start; skip.
      continue
    }

    for (const result of bucket.results || []) {
      if (!result || typeof result !== "object" || Array.isArray(result)) continue

      // Cost: `amount` is discounted, in fractional cents -> USD.
      const rawAmount = result.amount
      let costUsd: number
      if (rawAmount === null || rawAmount === undefined) {
        costUsd = 0.0
      } else {
        // toFloat returns 0 for unparseable input, matching Python's except
        // branch which defaults cost_usd to 0.0.
        costUsd = toFloat(rawAmount) / CENTS_PER_USD
      }

      const rawListAmount = result.list_amount
      let listAmountUsd: number | null
      if (rawListAmount === null || rawListAmount === undefined) {
        listAmountUsd = null
      } else {
        const n =
          typeof rawListAmount === "number"
            ? rawListAmount
            : parseFloat(String(rawListAmount))
        listAmountUsd = Number.isFinite(n) ? n / CENTS_PER_USD : null
      }

      // model_name must NEVER be null.
      const modelName = result.model || "claude-ai"

      // Join usage by (start, model, product).
      const usage = usageMap.get(resultKey(startingAt, result)) || {}

      const inputTokens = sumInputTokens(usage)
      const outputTokens = safeInt(usage.output_tokens)

      let tokensUsed: number | null
      if (inputTokens === null && outputTokens === null) {
        tokensUsed = null
      } else {
        tokensUsed = (inputTokens || 0) + (outputTokens || 0)
      }

      const requestCount =
        safeInt(usage.requests) ?? safeInt(result.requests) ?? 1

      records.push({
        user_id: ctx.userId,
        provider_id: ctx.providerId,
        timestamp: timestampIso,
        model_name: modelName,
        cost_usd: costUsd,
        tokens_used: tokensUsed,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        request_count: requestCount,
        collection_method: "api_automated",
        metadata: {
          provider: "claude-ai",
          list_amount_usd: listAmountUsd,
          bucket_width: bucketWidth,
          group: {
            model: result.model ?? null,
            product: result.product ?? null,
            cost_type: result.cost_type ?? null,
          },
          organization_id: ctx.organizationId ?? null,
          source: "cost_report",
          attribution: orgAttribution(),
        },
      })
    }
  }

  return records
}

function pageLimit(bucketWidth: string): number {
  if (bucketWidth === "1h") return 168
  if (bucketWidth === "1m") return 256
  return PAGE_LIMIT_1D
}

/** Fetch all paginated buckets for a single report endpoint. */
async function fetchReport(
  apiKey: string,
  endpoint: string,
  start: Date,
  end: Date,
  bucketWidth: string,
  groupBy: string[]
): Promise<any[]> {
  const headers = {
    "anthropic-version": ANTHROPIC_VERSION,
    "x-api-key": apiKey,
  }
  const limit = pageLimit(bucketWidth)

  let restartAttempts = 0
  while (true) {
    const allBuckets: any[] = []
    let nextPage: string | null = null
    let restart = false

    while (true) {
      const params = new URLSearchParams()
      params.set("starting_at", rfc3339(start))
      params.set("ending_at", rfc3339(end))
      params.set("bucket_width", bucketWidth)
      params.set("limit", String(limit))
      for (const g of groupBy) params.append("group_by[]", g)
      if (nextPage) params.set("page", nextPage)

      const url = `${LEGACY_BASE_URL}${endpoint}?${params.toString()}`
      const res = await fetchWithRetry(url, { method: "GET", headers })
      if (!res.ok) {
        // Cursors expire after a data refresh; restart from page 1.
        if (res.status === 410 && nextPage && restartAttempts < MAX_PAGINATION_RESTARTS) {
          restartAttempts++
          restart = true
          break
        }
        const body = await res.text().catch(() => "")
        throw new Error(
          `Claude Analytics ${endpoint} request failed: ${res.status} ${body}`
        )
      }
      const json: any = await res.json()

      const pageBuckets = json?.data || []
      for (const b of pageBuckets) allBuckets.push(b)

      if (!json?.has_more) return allBuckets
      nextPage = json?.next_page ?? null
      if (!nextPage) return allBuckets
    }

    if (!restart) return allBuckets
  }
}

/**
 * ANALYTICS transform: one record per /analytics/cost row (cost is the source
 * of truth, as in the legacy path); usage is joined by (bucket, full group).
 */
export function transformAnalytics(
  costRows: AnalyticsRow[],
  usageRows: AnalyticsRow[],
  ctx: { userId: string; providerId: string; organizationId?: string },
  bucketWidth: string = "1d"
): CostRecord[] {
  const usageMap = new Map<string, Record<string, any>>()
  for (const row of usageRows || []) {
    if (!row || typeof row !== "object") continue
    usageMap.set(rowKey(row), row.usage ?? {})
  }

  const records: CostRecord[] = []
  for (const row of costRows || []) {
    if (!row || typeof row !== "object") continue
    const timestamp = bucketIso(row.starting_at)
    if (timestamp === null) continue
    const group = row.group ?? {}
    const cost = row.cost ?? {}
    const usage = usageMap.get(rowKey(row))

    const inputTokens = sumInputTokens(usage)
    const outputTokens = safeInt(usage?.output_tokens)
    const tokensUsed =
      inputTokens === null && outputTokens === null ? null : (inputTokens || 0) + (outputTokens || 0)

    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp,
      model_name: str(group.model) ?? "claude-ai",
      cost_usd: toFloat(cost.amount) / CENTS_PER_USD,
      tokens_used: tokensUsed,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      request_count: safeInt(usage?.requests) ?? safeInt(cost.requests) ?? 1,
      collection_method: "api_automated",
      metadata: {
        provider: "claude-ai",
        list_amount_usd: cost.list_amount != null ? toFloat(cost.list_amount) / CENTS_PER_USD : null,
        bucket_width: bucketWidth,
        group: { model: group.model ?? null, product: group.product ?? null },
        organization_id: ctx.organizationId ?? null,
        source: "analytics",
        ...actorMetadata(group),
        attribution: groupAttribution(group),
      },
    })
  }
  return records
}

/**
 * Collect from the Analytics API for today plus the prior 30 UTC days (or
 * `backfillDays` with backfill, or exactly `opts.range` when given), falling back to the legacy reports on 403/404.
 */
async function collect(ctx: CollectorContext, opts: CollectOptions = {}): Promise<CostRecord[]> {
  const today = startOfUTCDay(new Date())
  const end = opts.range ? opts.range.end : new Date(today.getTime() + DAY_MS)
  const days = opts.backfill ? opts.backfillDays ?? 90 : DEFAULT_LOOKBACK_DAYS
  let start = opts.range ? opts.range.start : new Date(today.getTime() - days * DAY_MS)
  if (start.getTime() < MIN_DATA_MS) start = new Date(MIN_DATA_MS)
  const bucketWidth = "1d"
  const tctx = { userId: ctx.userId, providerId: ctx.providerId, organizationId: ctx.organizationId }

  try {
    const { cost, usage } = await fetchAnalytics(ctx.apiKey, start, end, ANALYTICS_GROUP_BY)
    return transformAnalytics(cost, usage, tctx, bucketWidth)
  } catch (e) {
    if (!(e instanceof AnalyticsUnavailableError)) throw e
    console.warn(`[claude-ai] ${e.message}; falling back to legacy cost_report`)
  }

  const allRecords: CostRecord[] = []
  for (const [chunkStart, chunkEnd] of iterChunks(start, end, MAX_SPAN_DAYS)) {
    const [costBuckets, usageBuckets] = await Promise.all([
      fetchReport(ctx.apiKey, "/cost_report", chunkStart, chunkEnd, bucketWidth, ["model"]),
      fetchReport(ctx.apiKey, "/usage_report", chunkStart, chunkEnd, bucketWidth, ["model"]),
    ])
    allRecords.push(...transform(costBuckets, usageBuckets, tctx, bucketWidth))
  }
  return allRecords
}

export const collector: Collector = { provider: "claude-ai", collect }
