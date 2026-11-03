/**
 * Explicit date-range re-pulls (issue #20).
 *
 * `/api/admin/collect` (and, optionally, the cron routes) accept
 * `start_date` / `end_date` as ISO `YYYY-MM-DD` UTC days, `end_date`
 * inclusive. This module validates them and turns them into the half-open
 * `[start, end + 1 day)` window the collectors fetch.
 *
 * Rules (each failure is a 400 with the returned message):
 * - both dates are required together;
 * - each must be a real calendar date in `YYYY-MM-DD` form;
 * - `start_date <= end_date`, span <= 31 days (inclusive), `end_date` <= today (UTC);
 * - only providers in RANGE_PROVIDERS support ranges;
 * - a `start_date` before the provider's earliest data is clamped to it
 *   (Anthropic / Claude.ai analytics: MIN_DATA_MS; OpenAI: today minus
 *   MAX_HISTORICAL_DAYS) and the clamp is reported. A range that ends before
 *   the earliest data is rejected.
 *
 * Vercel AI Gateway (issue #28): /v1/report takes inclusive start_date /
 * end_date, so a range maps straight onto it. Vercel documents no earliest
 * date or retention window for the report API, so the gateway is never
 * clamped: days before the team's first gateway request just return no rows
 * (the runner then leaves those days untouched). Prod data starts 2025-12-28.
 */

import { DAY_MS, isoDate, startOfUTCDay } from "./http"
import { MIN_DATA_MS } from "./anthropic-analytics"
import { MAX_HISTORICAL_DAYS } from "./openai"

import { MAX_RANGE_DAYS, RANGE_PROVIDERS } from "./range-providers"

export { MAX_RANGE_DAYS, RANGE_PROVIDERS }

/** Providers whose start_date is never clamped (no documented earliest data). */
const UNCLAMPED_PROVIDERS = new Set(["vercel-ai-gateway"])

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export interface ResolvedDateRange {
  /** Inclusive first UTC day actually fetched (after clamping). */
  start_date: string
  /** Inclusive last UTC day. */
  end_date: string
  /** The start_date the caller asked for. */
  requested_start_date: string
  /** True when start_date was moved forward to the provider's earliest data. */
  clamped: boolean
  /** Window passed to the collector: [start, end), end = end_date + 1 day. */
  start: Date
  end: Date
}

export type DateRangeResult =
  | { ok: true; range: ResolvedDateRange | null }
  | { ok: false; error: string }

/** Parse a strict `YYYY-MM-DD` into UTC-midnight ms, or null. */
export function parseIsoDay(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (Number.isNaN(ms)) return null
  // Reject dates that roll over (e.g. 2026-02-30).
  return isoDate(new Date(ms)) === value ? ms : null
}

/** Earliest UTC day (ms) the provider can return data for. */
export function earliestDataMs(provider: string, now: Date = new Date()): number {
  if (UNCLAMPED_PROVIDERS.has(provider)) return 0
  if (provider === "openai") {
    return startOfUTCDay(now).getTime() - MAX_HISTORICAL_DAYS * DAY_MS
  }
  return MIN_DATA_MS
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === ""
}

/**
 * Validate optional `start_date` / `end_date` for `provider`.
 * Both absent -> `{ ok: true, range: null }` (callers keep their old behaviour).
 */
export function resolveDateRange(
  provider: string,
  startDate: unknown,
  endDate: unknown,
  now: Date = new Date()
): DateRangeResult {
  if (isBlank(startDate) && isBlank(endDate)) return { ok: true, range: null }
  if (isBlank(startDate) || isBlank(endDate)) {
    return { ok: false, error: "start_date and end_date must be provided together" }
  }
  if (!(RANGE_PROVIDERS as readonly string[]).includes(provider)) {
    return {
      ok: false,
      error: `Provider '${provider}' does not support start_date/end_date. Supported: ${RANGE_PROVIDERS.join(", ")}`,
    }
  }

  const startMs = parseIsoDay(startDate)
  if (startMs === null) return { ok: false, error: "start_date must be a valid date in YYYY-MM-DD format" }
  const endMs = parseIsoDay(endDate)
  if (endMs === null) return { ok: false, error: "end_date must be a valid date in YYYY-MM-DD format" }

  if (startMs > endMs) return { ok: false, error: "start_date must be on or before end_date" }
  const spanDays = (endMs - startMs) / DAY_MS + 1
  if (spanDays > MAX_RANGE_DAYS) {
    return {
      ok: false,
      error: `Range spans ${spanDays} days; the maximum is ${MAX_RANGE_DAYS} (end_date inclusive). Split it into chunks.`,
    }
  }
  const todayMs = startOfUTCDay(now).getTime()
  if (endMs > todayMs) return { ok: false, error: "end_date must not be after today (UTC)" }

  const earliest = earliestDataMs(provider, now)
  if (endMs < earliest) {
    return {
      ok: false,
      error: `Range ends before the earliest data available for ${provider} (${isoDate(new Date(earliest))})`,
    }
  }
  const effectiveStart = Math.max(startMs, earliest)

  return {
    ok: true,
    range: {
      start_date: isoDate(new Date(effectiveStart)),
      end_date: endDate as string,
      requested_start_date: startDate as string,
      clamped: effectiveStart !== startMs,
      start: new Date(effectiveStart),
      end: new Date(endMs + DAY_MS),
    },
  }
}

/** Public, JSON-friendly view of a resolved range (no Date objects). */
export function describeRange(r: ResolvedDateRange) {
  return {
    start_date: r.start_date,
    end_date: r.end_date,
    requested_start_date: r.requested_start_date,
    clamped: r.clamped,
  }
}
