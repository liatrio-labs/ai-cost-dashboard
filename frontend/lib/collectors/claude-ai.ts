/**
 * Claude Enterprise Analytics API collector (TypeScript).
 *
 * Collects cost + usage data from the Claude Enterprise Analytics API — the
 * claude.ai / Claude for Work surface. This is DISTINCT from the Anthropic
 * developer Admin API: it lives under `/v1/organizations/analytics`, uses GET
 * endpoints driven by query params, and requires an API key with the
 * `read:analytics` scope.
 *
 * The transform treats the cost `amount` / `list_amount` fields as FRACTIONAL
 * CENTS (divided by CENTS_PER_USD = 100 to produce USD).
 */

import type {
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toFloat, toInt, rfc3339, startOfUTCDay, DAY_MS } from "./http"

const ANALYTICS_API_BASE_URL =
  "https://api.anthropic.com/v1/organizations/analytics"
const ANTHROPIC_VERSION = "2023-06-01"
// The Analytics API allows at most a 31-day span per request.
const MAX_SPAN_DAYS = 31
// `amount` / `list_amount` are returned in fractional cents.
const CENTS_PER_USD = 100.0

/** Build a join key matching cost and usage results within a bucket. */
function resultKey(startingAt: string | null | undefined, result: any): string {
  return JSON.stringify([
    startingAt ?? null,
    result?.model ?? null,
    result?.product ?? null,
  ])
}

/**
 * Sum all input-token flavours present in a usage result. Covers
 * `input_tokens`, `uncached_input_tokens`, `cache_read_input_tokens` and the
 * dotted cache-creation fields. Returns null if no input-token field is present.
 */
function sumInputTokens(result: any): number | null {
  const inputFieldNames = [
    "input_tokens",
    "uncached_input_tokens",
    "cache_read_input_tokens",
    "cache_creation.ephemeral_5m_input_tokens",
    "cache_creation.ephemeral_1h_input_tokens",
  ]
  let total = 0
  let found = false
  for (const name of inputFieldNames) {
    const value = result?.[name]
    if (value !== null && value !== undefined) {
      // Python uses int(value); coerce and skip non-numeric values.
      const n = typeof value === "number" ? value : parseInt(String(value), 10)
      if (Number.isFinite(n)) {
        total += toInt(Math.trunc(n))
        found = true
      }
    }
  }
  return found ? total : null
}

/** Coerce to int, returning null on failure or missing value. */
function safeInt(value: any): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === "number" ? value : parseInt(String(value), 10)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Transform Analytics API cost + usage buckets into cost_records rows.
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

      records.push({
        user_id: ctx.userId,
        provider_id: ctx.providerId,
        timestamp: timestampIso,
        model_name: modelName,
        cost_usd: costUsd,
        tokens_used: tokensUsed,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        request_count: 1,
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
        },
      })
    }
  }

  return records
}

/** Yield [chunkStart, chunkEnd] spans no longer than `maxDays`. */
function* iterChunks(
  start: Date,
  end: Date,
  maxDays: number
): Generator<[Date, Date]> {
  const maxMs = maxDays * 24 * 60 * 60 * 1000
  let chunkStart = start
  while (chunkStart.getTime() < end.getTime()) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + maxMs, end.getTime()))
    yield [chunkStart, chunkEnd]
    chunkStart = chunkEnd
  }
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
  const allBuckets: any[] = []
  let nextPage: string | null = null

  const headers = {
    "anthropic-version": ANTHROPIC_VERSION,
    "x-api-key": apiKey,
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams()
    params.set("starting_at", rfc3339(start))
    params.set("ending_at", rfc3339(end))
    params.set("bucket_width", bucketWidth)
    for (const g of groupBy) params.append("group_by[]", g)
    if (nextPage) params.set("page", nextPage)

    const url = `${ANALYTICS_API_BASE_URL}${endpoint}?${params.toString()}`
    const res = await fetchWithRetry(url, { method: "GET", headers })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(
        `Claude Analytics ${endpoint} request failed: ${res.status} ${body}`
      )
    }
    const json: any = await res.json()

    const pageBuckets = json?.data || []
    for (const b of pageBuckets) allBuckets.push(b)

    if (!json?.has_more) break
    nextPage = json?.next_page ?? null
    if (!nextPage) break
  }

  return allBuckets
}

/**
 * Collect cost + usage data from the Claude Enterprise Analytics API. Defaults
 * to the last 24h; with backfill, the last `backfillDays` (default 90) days.
 * Requests are chunked into <=31-day spans (the API's per-request max).
 */
async function collect(
  ctx: CollectorContext,
  opts: CollectOptions = {}
): Promise<CostRecord[]> {
  // bucket_width=1d needs UTC-midnight-aligned boundaries; cover from `days` ago
  // through the start of tomorrow (includes today's partial bucket).
  const today = startOfUTCDay(new Date())
  const end = new Date(today.getTime() + DAY_MS)
  const days = opts.backfill ? opts.backfillDays ?? 90 : 1
  let start = new Date(today.getTime() - days * DAY_MS)
  // The Enterprise Analytics API has no data before 2026-01-01 (returns 400).
  const MIN_DATA = Date.UTC(2026, 0, 1)
  if (start.getTime() < MIN_DATA) start = new Date(MIN_DATA)

  const bucketWidth = "1d"
  const groupBy = ["model"]
  const allRecords: CostRecord[] = []

  for (const [chunkStart, chunkEnd] of iterChunks(start, end, MAX_SPAN_DAYS)) {
    const [costBuckets, usageBuckets] = await Promise.all([
      fetchReport(
        ctx.apiKey,
        "/cost_report",
        chunkStart,
        chunkEnd,
        bucketWidth,
        groupBy
      ),
      fetchReport(
        ctx.apiKey,
        "/usage_report",
        chunkStart,
        chunkEnd,
        bucketWidth,
        groupBy
      ),
    ])

    const records = transform(
      costBuckets,
      usageBuckets,
      {
        userId: ctx.userId,
        providerId: ctx.providerId,
        organizationId: ctx.organizationId,
      },
      bucketWidth
    )
    for (const r of records) allRecords.push(r)
  }

  return allRecords
}

export const collector: Collector = { provider: "claude-ai", collect }
