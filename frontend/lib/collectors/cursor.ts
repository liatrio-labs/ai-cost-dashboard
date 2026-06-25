/**
 * Cursor Admin API data collector (TypeScript).
 *
 * Collects per-member, per-model, per-day cost + token usage from Cursor's
 * Admin API (Cursor Business / Team plans).
 *
 * Verified API facts (as of 2026-06):
 * - Base URL: https://api.cursor.com
 * - Auth: HTTP Basic with the admin API key as the *username* and an empty
 *   password, i.e. `Authorization: Basic base64("<API_KEY>:")`.
 *
 * PRIMARY SOURCE — POST /teams/filtered-usage-events
 *   The ONLY Cursor endpoint that exposes historical, per-event cost with token
 *   counts and a model breakdown. `/teams/spend` and `/teams/daily-usage-data`
 *   are both current-billing-cycle only and carry no token/model cost detail, so
 *   they cannot produce the daily history the dashboard needs.
 *
 *   Body (epoch MILLISECONDS, inclusive bounds):
 *     { startDate, endDate, page, pageSize }
 *   Constraints: date range cannot exceed 30 days per request (we chunk),
 *   results are paginated (default pageSize 10; we request more and follow
 *   pagination.hasNextPage).
 *
 *   Response:
 *     {
 *       totalUsageEventsCount, period: { startDate, endDate },
 *       pagination: { numPages, currentPage, pageSize, hasNextPage, hasPreviousPage },
 *       usageEvents: [
 *         {
 *           timestamp: "<epoch ms string>", userEmail, model, kind,
 *           maxMode, requestsCosts, isTokenBasedCall, isChargeable, isHeadless,
 *           chargedCents,                 // total charged for the event, in CENTS
 *           cursorTokenFee?,              // only when a token rate is enabled
 *           tokenUsage?: {                // present when isTokenBasedCall
 *             inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens,
 *             totalCents, discountPercentOff?
 *           }
 *         }
 *       ]
 *     }
 *
 * RECONCILIATION — POST /teams/spend (best-effort, never fatal)
 *   Cumulative current-cycle spend per member, in cents. We fetch it only to
 *   annotate each member's records with their cycle total (`member_cycle_spend_cents`)
 *   so event-derived cost can be reconciled against Cursor's billing view.
 *
 * Modeling decision:
 *   Emit ONE cost record per (UTC day x member email x model), summing
 *   chargedCents -> dollars and token counts across that group's events. This
 *   mirrors the other providers (per day x model) while preserving Cursor's
 *   per-member attribution in metadata. Per-day UTC-midnight timestamps make
 *   re-pulls idempotent under the runner's delete-then-insert-by-timestamp.
 */

import type {
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toInt, startOfUTCDay, DAY_MS, sleep } from "./http"

const ADMIN_API_BASE_URL = "https://api.cursor.com"

// filtered-usage-events: max 30-day window per request, paginated.
const MAX_WINDOW_DAYS = 30
const PAGE_SIZE = 1000
const MAX_PAGES_PER_WINDOW = 1000 // safety backstop against pagination loops
const RATE_LIMIT_DELAY_MS = 250 // small delay between paginated requests

interface TransformCtx {
  userId: string
  providerId: string
  teamId?: string
}

interface UsageEvent {
  timestamp?: string | number
  userEmail?: string
  model?: string
  kind?: string
  maxMode?: boolean
  isTokenBasedCall?: boolean
  isChargeable?: boolean
  chargedCents?: number
  cursorTokenFee?: number
  tokenUsage?: {
    inputTokens?: number
    outputTokens?: number
    cacheWriteTokens?: number
    cacheReadTokens?: number
    totalCents?: number
  } | null
}

interface Agg {
  day: string // ISO UTC-midnight
  email: string
  model: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  tokenCents: number
  requestCount: number
  chargeableCount: number
  kinds: Set<string>
}

/** Parse an event timestamp (epoch-ms string or number) to a Date, or null. */
function eventDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  const ms = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Transform Cursor usage events into cost_records rows, one per
 * (UTC day x member email x model).
 *
 * Pure: no network. cents -> dollars; model_name never null; skips events with
 * an unparseable timestamp. `spendByEmail` (current-cycle cents per member) is
 * an optional reconciliation annotation.
 */
export function transform(
  events: UsageEvent[],
  ctx: TransformCtx,
  spendByEmail: Record<string, number> = {}
): CostRecord[] {
  const groups = new Map<string, Agg>()

  for (const ev of events ?? []) {
    const d = eventDate(ev?.timestamp)
    if (!d) continue // can't bucket without a timestamp

    const day = startOfUTCDay(d).toISOString()
    const email = ev?.userEmail || "unknown"
    const model = ev?.model || "cursor" // model_name must never be null
    const key = `${day}|${email}|${model}`

    let agg = groups.get(key)
    if (!agg) {
      agg = {
        day,
        email,
        model,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        tokenCents: 0,
        requestCount: 0,
        chargeableCount: 0,
        kinds: new Set<string>(),
      }
      groups.set(key, agg)
    }

    // chargedCents is the authoritative per-event charge (cents -> dollars).
    const charged =
      typeof ev?.chargedCents === "number" ? ev.chargedCents : Number(ev?.chargedCents ?? 0)
    if (Number.isFinite(charged)) agg.costUsd += charged / 100

    const tu = ev?.tokenUsage
    if (tu) {
      agg.inputTokens += toInt(tu.inputTokens ?? 0)
      agg.outputTokens += toInt(tu.outputTokens ?? 0)
      agg.cacheWriteTokens += toInt(tu.cacheWriteTokens ?? 0)
      agg.cacheReadTokens += toInt(tu.cacheReadTokens ?? 0)
      const tc = typeof tu.totalCents === "number" ? tu.totalCents : Number(tu.totalCents ?? 0)
      if (Number.isFinite(tc)) agg.tokenCents += tc
    }

    agg.requestCount += 1
    if (ev?.isChargeable) agg.chargeableCount += 1
    if (ev?.kind) agg.kinds.add(String(ev.kind))
  }

  const records: CostRecord[] = []
  for (const agg of groups.values()) {
    const inTok = agg.inputTokens
    const outTok = agg.outputTokens
    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp: agg.day,
      model_name: agg.model,
      cost_usd: agg.costUsd,
      tokens_used: inTok + outTok,
      input_tokens: inTok,
      output_tokens: outTok,
      request_count: agg.requestCount || 1,
      collection_method: "api_automated",
      metadata: {
        provider: "cursor",
        member_email: agg.email,
        team_id: ctx.teamId ?? null,
        cache_write_tokens: agg.cacheWriteTokens,
        cache_read_tokens: agg.cacheReadTokens,
        token_cents: agg.tokenCents,
        chargeable_event_count: agg.chargeableCount,
        kinds: Array.from(agg.kinds),
        // Current-cycle reconciliation annotation (only meaningful for the
        // current billing cycle's days); cents.
        member_cycle_spend_cents: spendByEmail[agg.email] ?? null,
        day: agg.day.slice(0, 10),
      },
    })
  }

  return records
}

function basicAuthHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64")
}

/**
 * Fetch all usage events in [startMs, endMs] (<= 30 days), following
 * pagination until there are no more pages.
 */
async function fetchUsageEventsWindow(
  apiKey: string,
  startMs: number,
  endMs: number
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = []
  let page = 1

  while (page <= MAX_PAGES_PER_WINDOW) {
    const res = await fetchWithRetry(
      `${ADMIN_API_BASE_URL}/teams/filtered-usage-events`,
      {
        method: "POST",
        headers: {
          Authorization: basicAuthHeader(apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: startMs,
          endDate: endMs,
          page,
          pageSize: PAGE_SIZE,
        }),
      }
    )
    if (!res.ok) {
      throw new Error(
        `Cursor filtered-usage-events request failed: ${res.status} ${await res.text()}`
      )
    }
    const json = (await res.json()) as {
      usageEvents?: UsageEvent[]
      pagination?: { hasNextPage?: boolean; currentPage?: number }
    }
    const batch = json?.usageEvents ?? []
    events.push(...batch)

    const hasNext = json?.pagination?.hasNextPage === true
    if (!hasNext || batch.length === 0) break
    page += 1
    await sleep(RATE_LIMIT_DELAY_MS)
  }

  return events
}

/**
 * Fetch all usage events across [startMs, endMs] of arbitrary length by
 * chunking into <= 30-day windows.
 */
async function fetchAllUsageEvents(
  apiKey: string,
  startMs: number,
  endMs: number
): Promise<UsageEvent[]> {
  const windowMs = MAX_WINDOW_DAYS * DAY_MS
  const all: UsageEvent[] = []
  let cursor = startMs
  while (cursor <= endMs) {
    // Inclusive bounds on both ends; step by one full window minus 1ms so
    // adjacent windows never overlap (no double-counted boundary events).
    const winEnd = Math.min(cursor + windowMs - 1, endMs)
    const batch = await fetchUsageEventsWindow(apiKey, cursor, winEnd)
    all.push(...batch)
    cursor = winEnd + 1
  }
  return all
}

/**
 * Fetch current-cycle spend per member (cents), keyed by email. Best-effort:
 * any failure yields {} so reconciliation never blocks collection.
 */
async function fetchSpendByEmail(apiKey: string): Promise<Record<string, number>> {
  try {
    const res = await fetchWithRetry(`${ADMIN_API_BASE_URL}/teams/spend`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page: 1, pageSize: 100 }),
    })
    if (!res.ok) return {}
    const json = (await res.json()) as {
      teamMemberSpend?: Array<{ email?: string; spendCents?: number; overallSpendCents?: number }>
    }
    const out: Record<string, number> = {}
    for (const row of json?.teamMemberSpend ?? []) {
      if (!row?.email) continue
      const cents =
        typeof row.spendCents === "number"
          ? row.spendCents
          : typeof row.overallSpendCents === "number"
            ? row.overallSpendCents
            : null
      if (cents !== null && Number.isFinite(cents)) out[row.email] = cents
    }
    return out
  } catch {
    return {}
  }
}

async function collect(
  ctx: CollectorContext,
  opts: CollectOptions = {}
): Promise<CostRecord[]> {
  // bucket on UTC days. Cover from `days` ago through the start of tomorrow so
  // today's partial day is included.
  const today = startOfUTCDay(new Date())
  const days = opts.backfill ? opts.backfillDays ?? 90 : 1
  const startMs = today.getTime() - days * DAY_MS
  const endMs = today.getTime() + DAY_MS - 1

  const [events, spendByEmail] = await Promise.all([
    fetchAllUsageEvents(ctx.apiKey, startMs, endMs),
    fetchSpendByEmail(ctx.apiKey),
  ])

  return transform(
    events,
    { userId: ctx.userId, providerId: ctx.providerId, teamId: ctx.teamId },
    spendByEmail
  )
}

export const collector: Collector = {
  provider: "cursor",
  collect,
}
