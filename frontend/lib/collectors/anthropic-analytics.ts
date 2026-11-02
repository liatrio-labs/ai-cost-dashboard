/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Shared client + parsing for Anthropic's Usage & Cost Analytics API (beta),
 * used by both the `anthropic` (Console / Admin key) and `claude-ai`
 * (Enterprise / read:analytics key) collectors.
 *
 * Docs: https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api
 *
 *   GET /v1/organizations/analytics/cost
 *   GET /v1/organizations/analytics/usage
 *   Headers: anthropic-version, anthropic-beta: analytics-usage-cost-2026-08-24,
 *            x-api-key
 *   Params:  starting_at / ending_at (RFC 3339, end exclusive, <= 31 days),
 *            time_bucket_width=1d, group_by[] (<= 5), limit (<= 1000), page
 *   Response: { data: [ { starting_at, ending_at, group: {...}, cost|usage } ],
 *               has_more, next_page, data_refreshed_at }
 *   cost:  { amount, list_amount, currency, requests }  (amounts: cents, decimal strings)
 *   usage: { uncached_input_tokens, cache_creation: {ephemeral_5m_input_tokens,
 *            ephemeral_1h_input_tokens}, cache_read_input_tokens, output_tokens, requests }
 *   group.actor: { type: "user_actor", user_id, email_address, name }
 *              | { type: "api_actor", api_key_id }
 *              | { type: "service_account_actor", service_account_id }
 *              | { type: "federated_actor", provider, subject } | null
 *
 * Data refreshes within 4-24h; a 410 means the page cursor expired after a
 * refresh, so pagination restarts from page 1.
 */

import type { Attribution } from "./types"
import { fetchWithRetry, rfc3339, sleep, toFloat, DAY_MS } from "./http"
import { buildAttribution, normalizeEmail, str } from "./attribution"

export const ANALYTICS_BASE_URL = "https://api.anthropic.com/v1/organizations/analytics"
export const ANALYTICS_BETA = "analytics-usage-cost-2026-08-24"
export const ANTHROPIC_VERSION = "2023-06-01"
export const MAX_SPAN_DAYS = 31
export const PAGE_LIMIT = 1000
const MAX_PAGINATION_RESTARTS = 3
const PAGE_DELAY_MS = 1000 // 60 req/min per org
/** The Analytics API has no data before this date (400 otherwise). */
export const MIN_DATA_MS = Date.UTC(2026, 0, 1)

/** Thrown when the analytics endpoint is not available to this key/org. */
export class AnalyticsUnavailableError extends Error {
  constructor(public status: number, endpoint: string) {
    super(`Anthropic Analytics ${endpoint} unavailable: ${status}`)
    this.name = "AnalyticsUnavailableError"
  }
}

export interface AnalyticsRow {
  starting_at?: string
  ending_at?: string
  group?: Record<string, any> | null
  cost?: Record<string, any> | null
  usage?: Record<string, any> | null
}

/** Yield [chunkStart, chunkEnd] spans no longer than `maxDays`. */
export function* iterChunks(start: Date, end: Date, maxDays: number): Generator<[Date, Date]> {
  let chunkStart = start
  while (chunkStart.getTime() < end.getTime()) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + maxDays * DAY_MS, end.getTime()))
    yield [chunkStart, chunkEnd]
    chunkStart = chunkEnd
  }
}

/** Fetch every row of one analytics endpoint for [start, end) (<= 31 days). */
async function fetchSpan(
  apiKey: string,
  endpoint: "/cost" | "/usage",
  start: Date,
  end: Date,
  groupBy: string[]
): Promise<AnalyticsRow[]> {
  const headers = {
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ANALYTICS_BETA,
    "x-api-key": apiKey,
  }
  let restarts = 0
  while (true) {
    const rows: AnalyticsRow[] = []
    let page: string | null = null
    let restart = false
    while (true) {
      const params = new URLSearchParams()
      params.set("starting_at", rfc3339(start))
      params.set("ending_at", rfc3339(end))
      params.set("time_bucket_width", "1d")
      params.set("limit", String(PAGE_LIMIT))
      for (const g of groupBy) params.append("group_by[]", g)
      if (page) params.set("page", page)

      const res = await fetchWithRetry(`${ANALYTICS_BASE_URL}${endpoint}?${params}`, {
        method: "GET",
        headers,
      })
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          throw new AnalyticsUnavailableError(res.status, endpoint)
        }
        if (res.status === 410 && page && restarts < MAX_PAGINATION_RESTARTS) {
          restarts++
          restart = true
          break
        }
        const body = await res.text().catch(() => "")
        throw new Error(`Anthropic Analytics ${endpoint} request failed: ${res.status} ${body}`)
      }
      const json: any = await res.json()
      for (const r of json?.data ?? []) rows.push(r)
      page = json?.next_page ?? null
      if (!json?.has_more || !page) return rows
      await sleep(PAGE_DELAY_MS)
    }
    if (!restart) return rows
  }
}

/** Fetch cost + usage rows for [start, end), chunked into <= 31-day spans. */
export async function fetchAnalytics(
  apiKey: string,
  start: Date,
  end: Date,
  groupBy: string[]
): Promise<{ cost: AnalyticsRow[]; usage: AnalyticsRow[] }> {
  const cost: AnalyticsRow[] = []
  const usage: AnalyticsRow[] = []
  for (const [s, e] of iterChunks(start, end, MAX_SPAN_DAYS)) {
    const [c, u] = await Promise.all([
      fetchSpan(apiKey, "/cost", s, e, groupBy),
      fetchSpan(apiKey, "/usage", s, e, groupBy),
    ])
    cost.push(...c)
    usage.push(...u)
  }
  return { cost, usage }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Coerce to int, null on missing/invalid. */
export function safeInt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === "number" ? value : parseInt(String(value), 10)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Sum input-token flavours: uncached + cache read + cache creation (nested
 * object, or legacy dotted keys), falling back to a combined `input_tokens`.
 * Null when no input-token field is present.
 */
export function sumInputTokens(u: Record<string, any> | null | undefined): number | null {
  if (!u) return null
  let total = 0
  let found = false
  const add = (v: unknown) => {
    const n = safeInt(v)
    if (n !== null) {
      total += n
      found = true
    }
  }
  const nested = u.cache_creation
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    add(nested.ephemeral_5m_input_tokens)
    add(nested.ephemeral_1h_input_tokens)
  } else {
    add(u["cache_creation.ephemeral_5m_input_tokens"])
    add(u["cache_creation.ephemeral_1h_input_tokens"])
  }
  add(u.uncached_input_tokens)
  add(u.cache_read_input_tokens)
  if (found) return total
  return safeInt(u.input_tokens)
}

/** Cents (number or decimal string) -> USD. */
export function centsToUsd(value: unknown): number {
  return toFloat(value) / 100
}

/** Bucket start -> ISO, or null when unparseable. */
export function bucketIso(value: unknown): string | null {
  if (!value || typeof value !== "string") return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** Stable join key for a row: bucket start + its full group. */
export function rowKey(row: AnalyticsRow): string {
  const g = row.group ?? {}
  const sorted = Object.keys(g)
    .sort()
    .map((k) => [k, g[k]])
  return JSON.stringify([bucketIso(row.starting_at), sorted])
}

/**
 * Map an analytics group to Attribution. user_actor -> person; api_actor ->
 * api key; otherwise falls through to the grouped api_key_id, then
 * workspace_id, then org.
 */
export function groupAttribution(group: Record<string, any> | null | undefined): Attribution {
  const actor = group?.actor && typeof group.actor === "object" ? group.actor : null
  const isUser = actor?.type === "user_actor"
  return buildAttribution({
    person_email: isUser ? normalizeEmail(actor.email_address) : null,
    person_external_id: isUser ? str(actor.user_id) : null,
    person_name: isUser ? str(actor.name) : null,
    api_key_id: str(group?.api_key_id) ?? (actor?.type === "api_actor" ? str(actor.api_key_id) : null),
    workspace_id: str(group?.workspace_id),
  })
}

/** Non-person actor details worth keeping in metadata (never secrets). */
export function actorMetadata(group: Record<string, any> | null | undefined): Record<string, unknown> {
  const actor = group?.actor && typeof group.actor === "object" ? group.actor : null
  if (!actor) return { actor_type: null }
  const out: Record<string, unknown> = { actor_type: actor.type ?? null }
  if (actor.type === "service_account_actor") out.service_account_id = actor.service_account_id ?? null
  if (actor.type === "federated_actor") {
    out.federated_provider = actor.provider?.type ?? null
    out.federated_subject = actor.subject ?? null
  }
  return out
}
