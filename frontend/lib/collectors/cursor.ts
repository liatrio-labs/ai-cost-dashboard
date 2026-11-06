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
 *   `spendCents` is ON-DEMAND only (usage beyond the plan's included pool);
 *   `overallSpendCents` adds the included pool on top. We keep both in
 *   metadata (`member_cycle_spend_cents` is spendCents only, issue #73).
 *
 * Modeling decision:
 *   Emit ONE cost record per (UTC day x member email x model x billing tier),
 *   summing chargedCents -> dollars and token counts across that group's
 *   events. This mirrors the other providers (per day x model) while
 *   preserving Cursor's per-member attribution in metadata. Per-day
 *   UTC-midnight timestamps make re-pulls idempotent under the runner's
 *   delete-then-insert-by-timestamp.
 *
 * Billing tier (issue #73):
 *   Events whose kind is "Included in Business" are drawn from the plan's
 *   included pool and are not billed. They get `cost_usd = 0` (so they never
 *   reach monthly spend, the KPIs or the Cursor tool total) and keep their
 *   charged value in `metadata.included_value_usd`. Every other kind
 *   ("Usage-based", ...) is on-demand and keeps its chargedCents as cost_usd,
 *   matching /teams/spend `spendCents`. Included and on-demand events never
 *   share a row, so a mixed day stays separable (`metadata.billing_tier`).
 *
 * Past-month freeze (issue #73):
 *   Rows before CURSOR_ON_DEMAND_SINCE (2026-11-01) are dropped from collect()
 *   output, so a backfill re-pull corrects November 2026 onward but never
 *   deletes or rewrites October 2026 or earlier.
 */

import type {
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toInt, startOfUTCDay, DAY_MS, sleep } from "./http"
import { buildAttribution, normalizeEmail, orgAttribution } from "./attribution"

const ADMIN_API_BASE_URL = "https://api.cursor.com"

// filtered-usage-events: max 30-day window per request, paginated.
const MAX_WINDOW_DAYS = 30
const PAGE_SIZE = 1000
const MAX_PAGES_PER_WINDOW = 1000 // safety backstop against pagination loops
const RATE_LIMIT_DELAY_MS = 250 // small delay between paginated requests

/**
 * First UTC day collected with on-demand-only cost semantics (issue #73).
 * collect() never emits rows before it, so re-pulls leave earlier months alone.
 */
export const CURSOR_ON_DEMAND_SINCE = "2026-11-01"

/** "included": drawn from the plan's included pool, not billed. "on_demand": usage-based, billed. */
export type CursorBillingTier = "included" | "on_demand"

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
  billingTier?: string
  tokenUsage?: {
    inputTokens?: number
    outputTokens?: number
    cacheWriteTokens?: number
    cacheReadTokens?: number
    totalCents?: number
  } | null
}

/** Current-cycle /teams/spend per member email, in cents. */
export interface MemberSpend {
  /** On-demand only (Cursor's spendCents). */
  spendCents: Record<string, number>
  /** On-demand + included pool (Cursor's overallSpendCents). */
  overallSpendCents: Record<string, number>
}

interface Agg {
  day: string // ISO UTC-midnight
  email: string
  model: string
  tier: CursorBillingTier
  /** Sum of chargedCents for the group, in dollars (billed or not). */
  chargedUsd: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  tokenCents: number
  requestCount: number
  chargeableCount: number
  kinds: Set<string>
  billingTiers: Set<string>
}

/**
 * Billing tier of a usage event. Kind "Included in Business" (or any kind /
 * billingTier that says "included") is the included pool; everything else
 * ("Usage-based", errored / not-charged kinds with 0 cents, ...) is on-demand.
 */
export function cursorBillingTier(ev: { kind?: unknown; billingTier?: unknown } | null | undefined): CursorBillingTier {
  const kind = typeof ev?.kind === "string" ? ev.kind.toLowerCase() : ""
  const tier = typeof ev?.billingTier === "string" ? ev.billingTier.toLowerCase() : ""
  return kind.includes("included") || tier.includes("included") ? "included" : "on_demand"
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

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
 * (UTC day x member email x model x billing tier). Included-pool rows carry
 * cost_usd 0 and their charged value in metadata.included_value_usd.
 *
 * Pure: no network. cents -> dollars; model_name never null; skips events with
 * an unparseable timestamp. `spendByEmail` (current-cycle cents per member) is
 * an optional reconciliation annotation.
 */
export function transform(
  events: UsageEvent[],
  ctx: TransformCtx,
  spendByEmail: Record<string, number> | MemberSpend = {}
): CostRecord[] {
  const spend: MemberSpend =
    "spendCents" in spendByEmail && typeof spendByEmail.spendCents === "object"
      ? (spendByEmail as MemberSpend)
      : { spendCents: spendByEmail as Record<string, number>, overallSpendCents: {} }
  const groups = new Map<string, Agg>()

  for (const ev of events ?? []) {
    const d = eventDate(ev?.timestamp)
    if (!d) continue // can't bucket without a timestamp

    const day = startOfUTCDay(d).toISOString()
    const email = ev?.userEmail || "unknown"
    const model = ev?.model || "cursor" // model_name must never be null
    const tier = cursorBillingTier(ev)
    const key = `${day}|${email}|${model}|${tier}`

    let agg = groups.get(key)
    if (!agg) {
      agg = {
        day,
        email,
        model,
        tier,
        chargedUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        tokenCents: 0,
        requestCount: 0,
        chargeableCount: 0,
        kinds: new Set<string>(),
        billingTiers: new Set<string>(),
      }
      groups.set(key, agg)
    }

    // chargedCents is the per-event charge (cents -> dollars). Whether it is
    // billed depends on the tier (see the cost_usd mapping below).
    const charged =
      typeof ev?.chargedCents === "number" ? ev.chargedCents : Number(ev?.chargedCents ?? 0)
    if (Number.isFinite(charged)) agg.chargedUsd += charged / 100

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
    if (ev?.billingTier) agg.billingTiers.add(String(ev.billingTier))
  }

  const records: CostRecord[] = []
  for (const agg of groups.values()) {
    // Per member. Events with no userEmail ("unknown": Bugbot and other
    // team-level automation) stay org-level; the org rollups show them as
    // "Cursor – Bugbot/automation" rather than Unassigned (issue #51,
    // lib/org/rollup.ts isAutomationRow).
    const personEmail = agg.email === "unknown" ? null : normalizeEmail(agg.email)
    const inTok = agg.inputTokens
    const outTok = agg.outputTokens
    const included = agg.tier === "included"
    // Only on-demand (usage-based) spend is billable; the included pool is $0.
    const costUsd = included ? 0 : round6(agg.chargedUsd)
    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp: agg.day,
      model_name: agg.model,
      cost_usd: costUsd,
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
        ...(agg.billingTiers.size ? { billing_tiers: Array.from(agg.billingTiers) } : {}),
        // Issue #73: on-demand vs included-pool value. cost_usd is the
        // on-demand value; the included pool is shown, never billed.
        billing_tier: agg.tier,
        on_demand_value_usd: costUsd,
        included_value_usd: included ? round6(agg.chargedUsd) : 0,
        // Current-cycle reconciliation annotations (only meaningful for the
        // current billing cycle's days); cents. spendCents is on-demand only,
        // overallSpendCents adds the included pool.
        member_cycle_spend_cents: spend.spendCents[agg.email] ?? null,
        member_cycle_overall_spend_cents: spend.overallSpendCents[agg.email] ?? null,
        day: agg.day.slice(0, 10),
        attribution: personEmail
          ? buildAttribution({ person_email: personEmail }, "person")
          : orgAttribution(),
      },
    })
  }

  return records
}

/**
 * Append `items` onto `target` in place, one element at a time (issue #86).
 * `target.push(...items)` passes every element as a call argument, which
 * throws "Maximum call stack size exceeded" once a batch reaches ~120k+
 * events (a November 90-day backfill returned ~161k). A plain loop has no
 * argument-count limit. Returns `target` for convenience.
 */
export function appendAll<T>(target: T[], items: readonly T[]): T[] {
  for (let i = 0; i < items.length; i++) target.push(items[i])
  return target
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
    appendAll(events, batch)

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
export async function fetchAllUsageEvents(
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
    appendAll(all, batch)
    cursor = winEnd + 1
  }
  return all
}

/**
 * Fetch current-cycle spend per member (cents), keyed by email: on-demand
 * (spendCents) and overall (overallSpendCents) kept apart. Best-effort: any
 * failure yields empty maps so reconciliation never blocks collection.
 */
async function fetchSpendByEmail(apiKey: string): Promise<MemberSpend> {
  const out: MemberSpend = { spendCents: {}, overallSpendCents: {} }
  try {
    const res = await fetchWithRetry(`${ADMIN_API_BASE_URL}/teams/spend`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page: 1, pageSize: 100 }),
    })
    if (!res.ok) return out
    const json = (await res.json()) as {
      teamMemberSpend?: Array<{ email?: string; spendCents?: number; overallSpendCents?: number }>
    }
    for (const row of json?.teamMemberSpend ?? []) {
      if (!row?.email) continue
      if (typeof row.spendCents === "number" && Number.isFinite(row.spendCents)) {
        out.spendCents[row.email] = row.spendCents
      }
      if (typeof row.overallSpendCents === "number" && Number.isFinite(row.overallSpendCents)) {
        out.overallSpendCents[row.email] = row.overallSpendCents
      }
    }
    return out
  } catch {
    return out
  }
}

/**
 * Drop rows for days before CURSOR_ON_DEMAND_SINCE (issue #73). The runner
 * deletes only at the timestamps it inserts, so dropped days are untouched.
 */
export function withinOnDemandWindow(records: CostRecord[], since = CURSOR_ON_DEMAND_SINCE): CostRecord[] {
  return records.filter((r) => r.timestamp.slice(0, 10) >= since)
}

async function collect(
  ctx: CollectorContext,
  opts: CollectOptions = {}
): Promise<CostRecord[]> {
  // bucket on UTC days. Cover from `days` ago through the start of tomorrow so
  // today's partial day is included.
  const today = startOfUTCDay(new Date())
  const days = opts.backfill ? opts.backfillDays ?? 90 : 1
  // Never fetch before the on-demand cutoff (issue #73); earlier months stay frozen.
  const sinceMs = Date.parse(`${CURSOR_ON_DEMAND_SINCE}T00:00:00Z`)
  const startMs = Math.max(today.getTime() - days * DAY_MS, sinceMs)
  const endMs = today.getTime() + DAY_MS - 1

  const [events, spendByEmail] = await Promise.all([
    fetchAllUsageEvents(ctx.apiKey, startMs, endMs),
    fetchSpendByEmail(ctx.apiKey),
  ])

  return withinOnDemandWindow(
    transform(
      events,
      { userId: ctx.userId, providerId: ctx.providerId, teamId: ctx.teamId },
      spendByEmail
    )
  )
}

export const collector: Collector = {
  provider: "cursor",
  collect,
}
