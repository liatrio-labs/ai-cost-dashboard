/**
 * Cursor Admin API data collector (TypeScript port).
 *
 * Collects per-member usage and spend data from Cursor's Admin API
 * (Cursor Business / Team plans).
 *
 * Verified API facts (as of 2026-06):
 * - Base URL: https://api.cursor.com
 * - Auth: HTTP Basic with the admin API key as the *username* and an empty
 *   password, i.e. `Authorization: Basic base64("<API_KEY>:")`.
 *
 * Endpoints used:
 *
 *   POST /teams/daily-usage-data
 *     Body (epoch MILLISECONDS): { startDate, endDate }
 *     Response: { data: [ <per-member per-day usage rows> ] }
 *
 *   POST /teams/spend
 *     Body: { page, pageSize }
 *     Response: { teamMemberSpend: [ <per-member cumulative spend, in CENTS> ] }
 *
 * Modeling decision (mirrors the Python collector):
 *   The spend endpoint reports cumulative spend per member for the current
 *   billing cycle with no per-day breakdown, so we emit ONE cost record per
 *   member for the collection period, carrying the dollar spend and enriched
 *   with the most-used model and aggregated request counts from the usage rows.
 */

import type {
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toInt } from "./http"

const ADMIN_API_BASE_URL = "https://api.cursor.com"

interface TransformCtx {
  userId: string
  providerId: string
  teamId?: string
}

interface Period {
  start: string
  end: string
}

/**
 * Transform Cursor usage + spend data into cost_records rows.
 *
 * Pure: no network. cents -> dollars; model_name never null; one record per
 * member for the period; skips spend rows with unparseable spend.
 */
export function transform(
  spendRows: any[],
  usageRows: any[],
  ctx: TransformCtx,
  period: Period
): CostRecord[] {
  // Aggregate usage per member email so we can enrich each spend row.
  const usageByEmail: Record<
    string,
    { requestCount: number; mostUsedModel: string | null; userId: unknown }
  > = {}

  for (const row of usageRows ?? []) {
    const email = row?.email
    if (!email) {
      // Without an email we can't join to spend; skip enrichment.
      continue
    }

    const agg =
      usageByEmail[email] ??
      (usageByEmail[email] = {
        requestCount: 0,
        mostUsedModel: null,
        userId: row?.userId,
      })

    for (const field of [
      "chatRequests",
      "composerRequests",
      "agentRequests",
      "cmdkUsages",
    ]) {
      agg.requestCount += toInt(row?.[field] ?? 0)
    }

    // Keep the first non-null model we see (rows are per-day).
    if (agg.mostUsedModel === null && row?.mostUsedModel) {
      agg.mostUsedModel = row.mostUsedModel
    }
  }

  const records: CostRecord[] = []

  for (const spendRow of spendRows ?? []) {
    const email = spendRow?.email

    // cents -> dollars. spendCents preferred; fall back to overallSpendCents.
    let spendCents = spendRow?.spendCents
    if (spendCents === undefined || spendCents === null) {
      spendCents = spendRow?.overallSpendCents ?? 0
    }
    const cents =
      typeof spendCents === "number" ? spendCents : Number(spendCents ?? 0)
    if (!Number.isFinite(cents)) {
      // Unparseable spend -> skip this row entirely.
      continue
    }
    const costUsd = cents / 100

    const usageAgg = usageByEmail[email] ?? {
      requestCount: 0,
      mostUsedModel: null,
      userId: undefined,
    }

    // model_name must NEVER be null.
    const modelName = usageAgg.mostUsedModel || "cursor"

    // Prefer per-member usage request count; fall back to
    // fastPremiumRequests from the spend row; default to 1.
    let requestCount = usageAgg.requestCount || 0
    if (!requestCount) {
      requestCount = toInt(spendRow?.fastPremiumRequests ?? 0)
    }
    if (!requestCount) {
      requestCount = 1
    }

    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp: period.start,
      model_name: modelName,
      cost_usd: costUsd,
      tokens_used: null,
      input_tokens: null,
      output_tokens: null,
      request_count: requestCount,
      collection_method: "api_automated",
      metadata: {
        provider: "cursor",
        member_email: email ?? null,
        team_id: ctx.teamId ?? null,
        spend_cents: spendRow?.spendCents ?? null,
        overall_spend_cents: spendRow?.overallSpendCents ?? null,
        fast_premium_requests: spendRow?.fastPremiumRequests ?? null,
        period_start: period.start,
        period_end: period.end,
      },
    })
  }

  return records
}

function basicAuthHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64")
}

async function fetchDailyUsage(
  apiKey: string,
  startMs: number,
  endMs: number
): Promise<any[]> {
  const res = await fetchWithRetry(`${ADMIN_API_BASE_URL}/teams/daily-usage-data`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ startDate: startMs, endDate: endMs }),
  })
  if (!res.ok) {
    throw new Error(
      `Cursor daily-usage-data request failed: ${res.status} ${await res.text()}`
    )
  }
  const json = await res.json()
  return json?.data ?? []
}

async function fetchSpend(apiKey: string): Promise<any[]> {
  const res = await fetchWithRetry(`${ADMIN_API_BASE_URL}/teams/spend`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page: 1, pageSize: 100 }),
  })
  if (!res.ok) {
    throw new Error(
      `Cursor spend request failed: ${res.status} ${await res.text()}`
    )
  }
  const json = await res.json()
  return json?.teamMemberSpend ?? []
}

async function collect(
  ctx: CollectorContext,
  opts: CollectOptions = {}
): Promise<CostRecord[]> {
  const end = new Date()
  const days = opts.backfill ? opts.backfillDays ?? 90 : 1
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)

  const startMs = start.getTime()
  const endMs = end.getTime()

  const [usageRows, spendRows] = await Promise.all([
    fetchDailyUsage(ctx.apiKey, startMs, endMs),
    fetchSpend(ctx.apiKey),
  ])

  return transform(spendRows, usageRows, ctx, {
    start: start.toISOString(),
    end: end.toISOString(),
  })
}

export const collector: Collector = {
  provider: "cursor",
  collect,
}
