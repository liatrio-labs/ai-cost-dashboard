/**
 * Windsurf (Codeium) cost + usage collector (TypeScript).
 *
 * Windsurf is now under Cognition/Devin; docs at docs.devin.ai. This team is on
 * a QUOTA billing strategy: the v2 consumption endpoint rejects it
 * ({"error":"QUOTA billing strategy is not yet supported"}), and neither the v1
 * CascadeAnalytics API nor the team Analytics CSV export expose any credit or
 * dollar figure — both are USAGE-ONLY telemetry.
 *
 * COST BASIS — seat subscription (verified via the analytics CSV).
 *   On a QUOTA plan the $40/seat fee INCLUDES a credit quota, and this team's
 *   usage (1,434 Cascade messages over the period — confirmed identical in the
 *   API and the CSV export) is far inside quota → ZERO overage. So the real
 *   spend is simply seats x $40/month, NOT a per-message/credit figure. We
 *   spread it daily (per calendar month, so each full month sums to seats x $40)
 *   from the subscription start date. Configurable via env:
 *     WINDSURF_SEATS               (default 18  — "Total Users" from the CSV)
 *     WINDSURF_USD_PER_SEAT        (default 40)
 *     WINDSURF_SUBSCRIPTION_START  (default 2026-04-16 — first day of usage)
 *
 * USAGE ENRICHMENT — POST https://server.codeium.com/api/v1/CascadeAnalytics
 *   service_key in body, RFC3339 timestamps, query_requests:[{cascade_runs:{}}].
 *   Returns per (day, model) messagesSent. We aggregate this per day and attach
 *   it as metadata (messages_sent + per-model breakdown) so each daily cost row
 *   also carries what was actually used. No cost comes from here.
 *
 * One record per UTC day from the subscription start through today; per-day
 * UTC-midnight timestamps keep re-pulls idempotent (runner delete-then-insert).
 */

import type {
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toInt, toFloat, startOfUTCDay, DAY_MS, rfc3339, sleep } from "./http"

const API_URL = "https://server.codeium.com/api/v1/CascadeAnalytics"
const MAX_WINDOW_DAYS = 30
const RATE_LIMIT_DELAY_MS = 250

const DEFAULT_SEATS = 18
const DEFAULT_USD_PER_SEAT = 40
const DEFAULT_SUBSCRIPTION_START = "2026-04-16"

interface RunRow {
  day?: string
  model?: string
  messagesSent?: string | number
}

interface DayUsage {
  messages: number
  models: Record<string, number>
}

interface BuildCtx {
  userId: string
  providerId: string
  teamId?: string
  seats: number
  usdPerSeat: number
}

/** Number of days in the UTC calendar month containing `dayIso`. */
function daysInMonth(dayIso: string): number {
  const d = new Date(dayIso)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

/** Aggregate CascadeAnalytics run rows into per-UTC-day usage. Pure. */
export function aggregateRuns(runRows: RunRow[]): Record<string, DayUsage> {
  const byDay: Record<string, DayUsage> = {}
  for (const row of runRows ?? []) {
    const raw = row?.day
    if (!raw) continue
    const ms = Date.parse(raw)
    if (Number.isNaN(ms)) continue
    const day = startOfUTCDay(new Date(ms)).toISOString()
    const model = row?.model || "windsurf"
    const sent = toInt(row?.messagesSent ?? 0)

    const u = byDay[day] ?? (byDay[day] = { messages: 0, models: {} })
    u.messages += sent
    u.models[model] = (u.models[model] ?? 0) + sent
  }
  return byDay
}

/**
 * Build one cost record per day in `days`, each carrying the daily seat-
 * subscription cost (seats x $/seat / daysInMonth) enriched with that day's
 * usage. Pure: no network.
 */
export function buildRecords(
  days: string[],
  usageByDay: Record<string, DayUsage>,
  ctx: BuildCtx
): CostRecord[] {
  const records: CostRecord[] = []
  for (const day of days) {
    const dailyCost = (ctx.seats * ctx.usdPerSeat) / daysInMonth(day)
    const u = usageByDay[day] ?? { messages: 0, models: {} }
    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp: day,
      model_name: "windsurf",
      cost_usd: dailyCost,
      tokens_used: null,
      input_tokens: null,
      output_tokens: null,
      request_count: u.messages || 1,
      collection_method: "api_automated",
      metadata: {
        provider: "windsurf",
        team_id: ctx.teamId ?? null,
        cost_basis: "seat_subscription",
        seats: ctx.seats,
        usd_per_seat: ctx.usdPerSeat,
        messages_sent: u.messages,
        models: u.models,
        day: day.slice(0, 10),
      },
    })
  }
  return records
}

async function fetchRunsWindow(serviceKey: string, start: Date, end: Date): Promise<RunRow[]> {
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

async function fetchAllRuns(serviceKey: string, startMs: number, endMs: number): Promise<RunRow[]> {
  const windowMs = MAX_WINDOW_DAYS * DAY_MS
  const all: RunRow[] = []
  let cursor = startMs
  while (cursor < endMs) {
    const winEnd = Math.min(cursor + windowMs - 1, endMs)
    all.push(...(await fetchRunsWindow(serviceKey, new Date(cursor), new Date(winEnd))))
    cursor = winEnd + 1
    if (cursor < endMs) await sleep(RATE_LIMIT_DELAY_MS)
  }
  return all
}

async function collect(
  ctx: CollectorContext,
  opts: CollectOptions = {}
): Promise<CostRecord[]> {
  const seats = toInt(process.env.WINDSURF_SEATS) || DEFAULT_SEATS
  const usdPerSeat = toFloat(process.env.WINDSURF_USD_PER_SEAT) || DEFAULT_USD_PER_SEAT
  const subStartMs = startOfUTCDay(
    new Date(process.env.WINDSURF_SUBSCRIPTION_START || DEFAULT_SUBSCRIPTION_START)
  ).getTime()

  const today = startOfUTCDay(new Date())
  const numDays = opts.backfill ? opts.backfillDays ?? 90 : 1
  // Window of days to bill, clamped so we never bill before the subscription.
  const windowStart = Math.max(today.getTime() - (numDays - 1) * DAY_MS, subStartMs)
  if (windowStart > today.getTime()) return [] // subscription hasn't started

  // Enumerate each UTC day in [windowStart, today].
  const days: string[] = []
  for (let t = windowStart; t <= today.getTime(); t += DAY_MS) {
    days.push(new Date(t).toISOString())
  }

  // Usage enrichment (best-effort: cost stands on its own if this fails).
  let usageByDay: Record<string, DayUsage> = {}
  try {
    const runs = await fetchAllRuns(ctx.apiKey, windowStart, today.getTime() + DAY_MS)
    usageByDay = aggregateRuns(runs)
  } catch {
    usageByDay = {}
  }

  return buildRecords(days, usageByDay, {
    userId: ctx.userId,
    providerId: ctx.providerId,
    teamId: ctx.teamId,
    seats,
    usdPerSeat,
  })
}

export const collector: Collector = {
  provider: "windsurf",
  collect,
}
