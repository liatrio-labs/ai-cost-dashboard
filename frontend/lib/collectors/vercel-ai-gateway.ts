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
 * One record per UTC day, model_name "ai-gateway"; per-day UTC-midnight
 * timestamps keep re-pulls idempotent (runner delete-then-insert-by-timestamp).
 */

import type {
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toFloat, toInt, isoDate, startOfUTCDay, DAY_MS } from "./http"

const REPORT_URL = "https://ai-gateway.vercel.sh/v1/report"

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

/**
 * Transform AI Gateway daily report rows into cost_records, one per UTC day.
 * Pure: no network. Skips rows with an unparseable day.
 */
export function transform(rows: ReportRow[], ctx: TransformCtx): CostRecord[] {
  const records: CostRecord[] = []

  for (const row of rows ?? []) {
    const day = row?.day
    if (!day) continue
    const ms = Date.parse(`${day}T00:00:00Z`)
    if (Number.isNaN(ms)) continue
    const timestamp = startOfUTCDay(new Date(ms)).toISOString()

    const inTok = toInt(row?.input_tokens ?? 0)
    const outTok = toInt(row?.output_tokens ?? 0)

    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp,
      model_name: "ai-gateway",
      cost_usd: toFloat(row?.total_cost),
      tokens_used: inTok + outTok,
      input_tokens: inTok,
      output_tokens: outTok,
      request_count: toInt(row?.request_count ?? 0) || 1,
      collection_method: "api_automated",
      metadata: {
        provider: "vercel-ai-gateway",
        team_id: ctx.teamId ?? null,
        market_cost: toFloat(row?.market_cost),
        cached_input_tokens: toInt(row?.cached_input_tokens ?? 0),
        cache_creation_input_tokens: toInt(row?.cache_creation_input_tokens ?? 0),
        reasoning_tokens: toInt(row?.reasoning_tokens ?? 0),
        day,
      },
    })
  }

  return records
}

async function fetchReport(
  apiKey: string,
  startDate: string,
  endDate: string
): Promise<ReportRow[]> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    group_by: "day",
    date_part: "day",
  })
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

async function collect(
  ctx: CollectorContext,
  opts: CollectOptions = {}
): Promise<CostRecord[]> {
  const today = startOfUTCDay(new Date())
  // Daily run: cover yesterday+today (results can lag a few minutes); backfill:
  // the requested window. Dates are inclusive YYYY-MM-DD in UTC.
  const days = opts.backfill ? opts.backfillDays ?? 90 : 2
  const startDate = isoDate(new Date(today.getTime() - days * DAY_MS))
  const endDate = isoDate(today)

  const rows = await fetchReport(ctx.apiKey, startDate, endDate)
  return transform(rows, {
    userId: ctx.userId,
    providerId: ctx.providerId,
    teamId: ctx.teamId,
  })
}

export const collector: Collector = {
  provider: "vercel-ai-gateway",
  collect,
}
