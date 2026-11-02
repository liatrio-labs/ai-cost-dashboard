/**
 * Active-period resolution shared by GET /api/dashboard and
 * GET /api/dashboard/breakdown.
 */

import type { PeriodParams } from "./filters"

export interface ResolvedPeriod {
  start: string // YYYY-MM-DD inclusive
  end: string // YYYY-MM-DD inclusive
  mode: "month" | "range"
  selectedMonth: string | null
}

export const monthOf = (d: string) => d.slice(0, 7) // YYYY-MM

export function monthBounds(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, "0")}` }
}

export const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10)

/** Custom range (start+end) | a month | default current month. */
export function resolvePeriod(p: PeriodParams, now: Date = new Date()): ResolvedPeriod {
  if (p.start && p.end) {
    return {
      start: p.start < p.end ? p.start : p.end,
      end: p.start < p.end ? p.end : p.start,
      mode: "range",
      selectedMonth: null,
    }
  }
  const ym = p.month || monthOf(now.toISOString())
  const b = monthBounds(ym)
  return { start: b.start, end: b.end, mode: "month", selectedMonth: ym }
}

/** The preceding window of equal length (what the KPI change % compares against). */
export function precedingWindow(start: string, end: string): { start: string; end: string } {
  const len = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1)
  return { start: addDays(start, -len), end: addDays(start, -1) }
}

/**
 * Comparison window for per-entity change: the previous calendar month in
 * month mode (true MoM), else the preceding equal-length window.
 */
export function comparisonWindow(p: ResolvedPeriod): { start: string; end: string } {
  if (p.mode === "month" && p.selectedMonth) {
    const [y, m] = p.selectedMonth.split("-").map(Number)
    const d = new Date(Date.UTC(y, m - 2, 1))
    return monthBounds(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  return precedingWindow(p.start, p.end)
}
