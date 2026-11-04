/**
 * Series fed to recharts for Spend Trends and Spend Forecast (issue #39).
 * Pure, so the solid/dotted split is tested without rendering.
 *
 * Each point has `actual` (the solid line) and `projected` (the dotted line).
 * The solid line ends at the last complete month; the dotted line starts on
 * that same point (so the two connect) and runs through the projected current
 * month (and, for the forecast, on to December). A partial month is never on
 * the solid line.
 */

import {
  formatMonthLabel,
  type CurrentMonthProjection,
  type DashboardForecast,
  type DashboardTrend,
} from "@/lib/dashboard-types"

export interface ChartPoint {
  /** YYYY-MM */
  ym: string
  /** Axis label, e.g. "Nov 2026". */
  month: string
  actual: number | null
  projected: number | null
  /** On the projected current month: spend recorded so far. */
  actualToDate?: number
}

/** Spend Trends: monthly totals, with the current month projected when `current` is set. */
export function trendSeries(trends: DashboardTrend[], current?: CurrentMonthProjection | null): ChartPoint[] {
  const rows = (trends || []).map((t) => ({ ym: t.month, total: Number(t.total) || 0 }))
  if (!current) {
    return rows.map((r) => ({ ym: r.ym, month: formatMonthLabel(r.ym), actual: r.total, projected: null }))
  }
  const complete = rows.filter((r) => r.ym < current.month)
  const out: ChartPoint[] = complete.map((r, i) => ({
    ym: r.ym,
    month: formatMonthLabel(r.ym),
    actual: r.total,
    projected: i === complete.length - 1 ? r.total : null,
  }))
  out.push({
    ym: current.month,
    month: formatMonthLabel(current.month),
    actual: null,
    projected: current.projected,
    actualToDate: current.actualToDate,
  })
  return out
}

/** Spend Forecast: actual history (solid), then projected points (dotted) starting at the last actual. */
export function forecastSeries(forecast: DashboardForecast[]): ChartPoint[] {
  const rows = forecast || []
  const lastActual = rows.reduce((acc, r, i) => (!r.projected ? i : acc), -1)
  return rows.map((r, i) => ({
    ym: r.month,
    month: formatMonthLabel(r.month),
    actual: !r.projected ? r.total : null,
    projected: r.projected || i === lastActual ? r.total : null,
    ...(r.actualToDate !== undefined ? { actualToDate: r.actualToDate } : {}),
  }))
}
