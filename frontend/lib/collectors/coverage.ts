/**
 * Missing / short provider-day check (#21). Pure: no I/O.
 *
 * Given per-provider daily totals, flag each UTC day in a recent window that is
 * either missing (no row at all) or whose total is below `fraction` of the
 * median of that provider's trailing `trailingWindow` days.
 *
 * - The window is the `lookbackDays` complete UTC days ending yesterday
 *   relative to `asOf`. Today is excluded: it is still accumulating and would
 *   always look short.
 * - The trailing median for a day uses only the days in
 *   [day - trailingWindow, day - 1] that have a row. Missing days do not count
 *   as $0, so an outage does not drag the baseline down.
 * - A day with no history (no rows in its trailing window) is not flagged, so a
 *   newly added provider produces no noise.
 * - A day whose trailing median is $0 (a provider with no spend) is not flagged.
 *
 * Surfaced by GET /api/admin/coverage (admin only), which reads
 * cost_records_daily.
 */

export interface DailyTotal {
  provider: string
  /** UTC day, YYYY-MM-DD. */
  date: string
  total: number
}

export interface CoverageOptions {
  /** Complete UTC days to check, ending yesterday. Default 7. */
  lookbackDays?: number
  /** Days before each checked day used for its median. Default 14. */
  trailingWindow?: number
  /** Flag a day whose total is below fraction x median. Default 0.25. */
  fraction?: number
  /** Reference "now"; the window ends the UTC day before it. Default: now. */
  asOf?: Date
}

export interface CoverageGap {
  provider: string
  date: string
  reason: "missing" | "low"
  /** null when missing. */
  total: number | null
  median: number
  /** fraction x median: the total a day needed to not be flagged. */
  threshold: number
}

export const COVERAGE_DEFAULTS = { lookbackDays: 7, trailingWindow: 14, fraction: 0.25 } as const

const DAY_MS = 24 * 60 * 60 * 1000

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The checked days, oldest first: the `lookbackDays` UTC days before `asOf`'s day. */
export function coverageWindow(lookbackDays: number, asOf: Date = new Date()): string[] {
  const today = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate())
  const days: string[] = []
  for (let i = lookbackDays; i >= 1; i--) days.push(isoDay(today - i * DAY_MS))
  return days
}

export function findCoverageGaps(dailyTotals: DailyTotal[], opts: CoverageOptions = {}): CoverageGap[] {
  const lookbackDays = opts.lookbackDays ?? COVERAGE_DEFAULTS.lookbackDays
  const trailingWindow = opts.trailingWindow ?? COVERAGE_DEFAULTS.trailingWindow
  const fraction = opts.fraction ?? COVERAGE_DEFAULTS.fraction
  const window = coverageWindow(lookbackDays, opts.asOf)

  // provider -> date -> summed total (input may hold several rows per day).
  const byProvider = new Map<string, Map<string, number>>()
  for (const r of dailyTotals) {
    const day = String(r.date).slice(0, 10)
    const totals = byProvider.get(r.provider) ?? new Map<string, number>()
    totals.set(day, (totals.get(day) ?? 0) + (Number(r.total) || 0))
    byProvider.set(r.provider, totals)
  }

  const gaps: CoverageGap[] = []
  for (const provider of Array.from(byProvider.keys()).sort()) {
    const totals = byProvider.get(provider)!
    for (const date of window) {
      const dayMs = Date.parse(`${date}T00:00:00Z`)
      const history: number[] = []
      for (let i = 1; i <= trailingWindow; i++) {
        const v = totals.get(isoDay(dayMs - i * DAY_MS))
        if (v !== undefined) history.push(v)
      }
      if (!history.length) continue // no history: nothing to compare against
      const med = median(history)
      if (med <= 0) continue // zero-spend provider
      const threshold = fraction * med
      const total = totals.get(date)
      if (total === undefined) {
        gaps.push({ provider, date, reason: "missing", total: null, median: med, threshold })
      } else if (total < threshold) {
        gaps.push({ provider, date, reason: "low", total, median: med, threshold })
      }
    }
  }
  return gaps
}
