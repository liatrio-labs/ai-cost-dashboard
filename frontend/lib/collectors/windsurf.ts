/**
 * Windsurf (Codeium) usage collector (TypeScript).
 *
 * Windsurf is now under Cognition/Devin; docs live at docs.devin.ai. This team
 * is on a QUOTA billing strategy, which the v2 consumption endpoint
 * (`/api/v2alpha/analytics/consumption`) explicitly rejects:
 *   {"error":"QUOTA billing strategy is not yet supported by this endpoint"}
 * and the v1 CascadeAnalytics endpoint exposes USAGE ONLY — no credit or dollar
 * field. So there is no API-reported spend for this plan.
 *
 * SOURCE — POST https://server.codeium.com/api/v1/CascadeAnalytics
 *   Body: {
 *     service_key,                       // Analytics Read service key
 *     start_timestamp, end_timestamp,    // RFC3339 strings (proto Timestamp)
 *     query_requests: [{ cascade_runs: {} }]
 *   }
 *   Response: { queryResults: [{ cascadeRuns: { cascadeRuns: [
 *     { day, model, mode, messagesSent, cascadeId } ] } }] }
 *   (string-typed numbers; no email attribution; no credits.)
 *
 * COST EXTRAPOLATION (no real $ available):
 *   credits  = messagesSent * WINDSURF_CREDITS_PER_MESSAGE  (default 1)
 *   cost_usd = credits * WINDSURF_USD_PER_CREDIT            (default 0.04)
 *   This values usage at the flex-credit rate; on a QUOTA plan these credits are
 *   included in the flat $40/seat subscription, so cost_usd is a usage-equivalent
 *   ESTIMATE, not an incremental bill. The flat per-seat base is not in this API
 *   and is tracked separately. Raw messagesSent + the rates used are kept in
 *   metadata so any rate can be re-derived without re-collecting.
 */

import type {
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toInt, toFloat, startOfUTCDay, DAY_MS, rfc3339, sleep } from "./http"

const API_URL = "https://server.codeium.com/api/v1/CascadeAnalytics"
// v1 has no documented max window; chunk conservatively like the other collectors.
const MAX_WINDOW_DAYS = 30
const RATE_LIMIT_DELAY_MS = 250

const DEFAULT_USD_PER_CREDIT = 0.04
const DEFAULT_CREDITS_PER_MESSAGE = 1

interface RunRow {
  day?: string
  model?: string
  mode?: string
  messagesSent?: string | number
  cascadeId?: string
}

interface TransformCtx {
  userId: string
  providerId: string
  teamId?: string
  usdPerCredit: number
  creditsPerMessage: number
}

interface Agg {
  day: string
  model: string
  messages: number
  modes: Set<string>
  cascades: Set<string>
}

/**
 * Transform CascadeAnalytics run rows into cost_records, one per
 * (UTC day x model). Pure: no network. Skips rows with an unparseable day.
 */
export function transform(runRows: RunRow[], ctx: TransformCtx): CostRecord[] {
  const groups = new Map<string, Agg>()

  for (const row of runRows ?? []) {
    const raw = row?.day
    if (!raw) continue
    const ms = Date.parse(raw)
    if (Number.isNaN(ms)) continue
    const day = startOfUTCDay(new Date(ms)).toISOString()
    const model = row?.model || "windsurf"
    const key = `${day}|${model}`

    let agg = groups.get(key)
    if (!agg) {
      agg = { day, model, messages: 0, modes: new Set(), cascades: new Set() }
      groups.set(key, agg)
    }
    agg.messages += toInt(row?.messagesSent ?? 0)
    if (row?.mode) agg.modes.add(String(row.mode))
    if (row?.cascadeId) agg.cascades.add(String(row.cascadeId))
  }

  const records: CostRecord[] = []
  for (const agg of groups.values()) {
    const credits = agg.messages * ctx.creditsPerMessage
    const costUsd = credits * ctx.usdPerCredit
    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp: agg.day,
      model_name: agg.model,
      cost_usd: costUsd,
      tokens_used: null,
      input_tokens: null,
      output_tokens: null,
      request_count: agg.messages || 1,
      collection_method: "api_automated",
      metadata: {
        provider: "windsurf",
        team_id: ctx.teamId ?? null,
        messages_sent: agg.messages,
        cascade_count: agg.cascades.size,
        modes: Array.from(agg.modes),
        credits_estimated: credits,
        usd_per_credit: ctx.usdPerCredit,
        credits_per_message: ctx.creditsPerMessage,
        cost_basis: "extrapolated_from_messages",
        day: agg.day.slice(0, 10),
      },
    })
  }

  return records
}

async function fetchRunsWindow(
  serviceKey: string,
  start: Date,
  end: Date
): Promise<RunRow[]> {
  const res = await fetchWithRetry(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_key: serviceKey,
      start_timestamp: rfc3339(start),
      end_timestamp: rfc3339(end),
      query_requests: [{ cascade_runs: {} }],
    }),
  })
  if (!res.ok) {
    throw new Error(
      `Windsurf CascadeAnalytics request failed: ${res.status} ${await res.text()}`
    )
  }
  const json = (await res.json()) as {
    queryResults?: Array<{ cascadeRuns?: { cascadeRuns?: RunRow[] } }>
  }
  for (const q of json?.queryResults ?? []) {
    if (q?.cascadeRuns?.cascadeRuns) return q.cascadeRuns.cascadeRuns
  }
  return []
}

async function collect(
  ctx: CollectorContext,
  opts: CollectOptions = {}
): Promise<CostRecord[]> {
  const today = startOfUTCDay(new Date())
  const days = opts.backfill ? opts.backfillDays ?? 90 : 1
  const startMs = today.getTime() - days * DAY_MS
  const endMs = today.getTime() + DAY_MS // include today's partial day

  const usdPerCredit = toFloat(process.env.WINDSURF_USD_PER_CREDIT) || DEFAULT_USD_PER_CREDIT
  const creditsPerMessage =
    toFloat(process.env.WINDSURF_CREDITS_PER_MESSAGE) || DEFAULT_CREDITS_PER_MESSAGE

  const windowMs = MAX_WINDOW_DAYS * DAY_MS
  const allRuns: RunRow[] = []
  let cursor = startMs
  while (cursor < endMs) {
    // Non-overlapping windows: end 1ms before the next window starts so a
    // day-bucketed row is never returned in two windows (double-counted).
    const winEnd = Math.min(cursor + windowMs - 1, endMs)
    const runs = await fetchRunsWindow(ctx.apiKey, new Date(cursor), new Date(winEnd))
    allRuns.push(...runs)
    cursor = winEnd + 1
    if (cursor < endMs) await sleep(RATE_LIMIT_DELAY_MS)
  }

  return transform(allRuns, {
    userId: ctx.userId,
    providerId: ctx.providerId,
    teamId: ctx.teamId,
    usdPerCredit,
    creditsPerMessage,
  })
}

export const collector: Collector = {
  provider: "windsurf",
  collect,
}
