/**
 * Shared types for the dashboard UI, mirroring the GET /api/dashboard contract.
 * Components are presentational and consume these via props.
 */

import type { CurrentMonthProjection, DashboardProjection, ProjectionBasis } from "@/lib/dashboard-compute"
import type { ProductSlice } from "@/lib/claude-ai-products"
export type { CurrentMonthProjection, DashboardProjection, ProjectionBasis }

export interface DashboardTool {
  id: string
  name: string
  monthlySpend: number
  usageVolume: string
  change: "up" | "down" | "stable"
  changePercent: number
  changeDirection: "up" | "down" | "stable"
  subscriptionType: string
  color: string
  description?: string
  adminUrl?: string
  lastUpdated?: string | null
  /** Issue #39, set when the period contains today: the period projected to its end. */
  projectedSpend?: number
  /** Spend in the previous full period (what the projected change compares with). */
  compareSpend?: number
  /** Signed, 1 decimal; null when there was no prior spend ("new"). */
  projectedChangePercent?: number | null
  /** Issue #48, Claude.ai only: Claude Code / Chat / Other, summing to monthlySpend. */
  products?: ProductSlice[]
}

export interface DashboardTrend {
  month: string // YYYY-MM
  total: number
  [providerSlug: string]: number | string
}

export interface DashboardByModel {
  model: string
  total: number
  color: string
}

export interface DashboardKpis {
  totalSpend: number
  prevSpend: number
  changePercent: number
  totalTokens: number
  activeProviders: number
  topProvider: string
}

export interface DashboardForecast {
  month: string // YYYY-MM
  total: number
  projected: boolean
  /** Set on the projected current month: spend recorded so far. */
  actualToDate?: number
}

/** Team/department forecast details (issue #9). */
export interface DashboardUnitForecast {
  level: "department" | "team"
  key: string // entity id or "unassigned"
  unassigned: boolean
  share: number // trailing 3-month share of org spend (0..1)
  trailingSpend: number
  allocatedPlateau: number // org plateau x share
  plateau: number // effective plateau (override or allocated)
  override: "plateau" | "headcount" | null
}

export interface DashboardForecastMeta {
  employees: number
  plateau: number // org plateau
  perPersonPct: number
  baselineEmployees: number
  unit?: DashboardUnitForecast // set when a team/department filter is active
  trailingAverage?: number // person/key filters: trailing 3-month average
}

export interface DashboardPeriod {
  start: string // YYYY-MM-DD inclusive
  end: string // YYYY-MM-DD inclusive
  mode: "month" | "range"
}

export interface DashboardData {
  months: string[]
  selectedMonth: string | null // set in month mode, null for a custom range
  dataStart: string | null // earliest date with data (YYYY-MM-DD)
  dataEnd: string | null
  period: DashboardPeriod
  tools: DashboardTool[]
  trends: DashboardTrend[]
  byModel: DashboardByModel[]
  kpis: DashboardKpis
  forecast: DashboardForecast[]
  forecastMeta?: DashboardForecastMeta
  /** Issue #39: period status and projections (lib/projection.ts). */
  projection?: DashboardProjection
}

const signed = (n: number) => `${n > 0 ? "+" : ""}${n}%`

/** "+0.7% projected", "new" (no prior spend), for a projected change. */
export function projectedChangeLabel(changePercent: number | null | undefined): string {
  if (changePercent === null || changePercent === undefined) return "new"
  return `${signed(changePercent)} projected`
}

/** Tooltip for a projected figure: "Projected from 3 complete days (through Nov 3); actual to date $X". */
export function projectionTooltip(basis: ProjectionBasis | null | undefined, actualToDate: number): string {
  const days = basis?.completeDays ?? 0
  const through = basis?.completeThrough
    ? ` (through ${new Date(`${basis.completeThrough}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })})`
    : ""
  const from = days > 0 ? `Projected from ${days} complete day${days === 1 ? "" : "s"}${through}` : "Projected from the trailing 28-day average (no complete days yet)"
  return `${from}; actual to date ${formatCurrency(actualToDate)}`
}

/** Format a "YYYY-MM-DD" date range into a short label like "Jan 5 – Mar 20, 2026". */
export function formatRangeLabel(start: string, end: string): string {
  const s = new Date(start + "T00:00:00")
  const e = new Date(end + "T00:00:00")
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
  const sameYear = s.getFullYear() === e.getFullYear()
  const sLabel = s.toLocaleDateString("en-US", opts)
  const eLabel = e.toLocaleDateString("en-US", { ...opts, year: "numeric" })
  return sameYear ? `${sLabel} – ${eLabel}` : `${s.toLocaleDateString("en-US", { ...opts, year: "numeric" })} – ${eLabel}`
}

/** Format a "YYYY-MM" string into a short label like "Jun 2026". */
export function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  if (!y || !m) return ym
  const date = new Date(y, m - 1, 1)
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" })
}

/** Format a "YYYY-MM" string into a long label like "June 2026". */
export function formatMonthLong(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  if (!y || !m) return ym
  const date = new Date(y, m - 1, 1)
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" })
}

export const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)

/** Card subtitle: what the projection is, for the org, a unit, or a person/key view. */
export function forecastDescription(
  meta?: DashboardForecastMeta,
  unitLabel?: string,
  hasProjection = true,
  current?: CurrentMonthProjection | null
): string {
  const u = meta?.unit
  if (u) {
    const name = unitLabel || (u.unassigned ? "Unassigned" : u.level === "team" ? "this team" : "this department")
    const basis = u.override
      ? `admin ${u.override} override`
      : `${(u.share * 100).toFixed(1)}% of trailing 3-month org spend`
    return `${name}: plateau ${formatCurrency(u.plateau)}/mo (${basis})`
  }
  if (meta?.trailingAverage !== undefined) {
    const avg = `trailing 3-month average ${formatCurrency(meta.trailingAverage)}/mo`
    if (current) {
      const change =
        current.changePercent === null ? "new" : `${signed(current.changePercent)} vs ${formatMonthLabel(current.prevMonth)}`
      return `Projected ${formatMonthLabel(current.month)}: ${formatCurrency(current.projected)} (${change}); ${avg}`
    }
    return `No forecast for this view; ${avg}`
  }
  if (!hasProjection) return "History only for this view"
  return "History (solid) with trend projection (dashed)"
}
