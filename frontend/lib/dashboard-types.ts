/**
 * Shared types for the dashboard UI, mirroring the GET /api/dashboard contract.
 * Components are presentational and consume these via props.
 */

import type { CurrentMonthProjection, CursorCostTypes, DashboardProjection, ProjectionBasis } from "@/lib/dashboard-compute"
import type { ProductSlice } from "@/lib/product-breakdown"
export type { CurrentMonthProjection, CursorCostTypes, DashboardProjection, ProjectionBasis }

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
  /**
   * Issue #48, Claude.ai: Claude Code / Chat / Other. Issue #65, Cursor: Grok
   * Bot / Bugbot / Agent/Chat. Sums to monthlySpend.
   */
  products?: ProductSlice[]
  /** Issue #88, Cursor only: seats vs calendar-month on-demand, and the seat composition. */
  cursorCostTypes?: CursorCostTypes
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

/** Issue #88: a seat / license / flat-fee total (not a model). */
export interface DashboardLicense {
  /** "Claude Ultra seats", "Cursor seats", "Lovable subscription". */
  label: string
  kind: "seats" | "subscription" | "invoice_adjustment"
  provider: string
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
  /** Issue #88: seats and licenses, excluded from byModel. Optional for older payloads. */
  byLicense?: DashboardLicense[]
  kpis: DashboardKpis
  forecast: DashboardForecast[]
  forecastMeta?: DashboardForecastMeta
  /** Issue #39: period status and projections (lib/projection.ts). */
  projection?: DashboardProjection
}

const signed = (n: number) => `${n > 0 ? "+" : ""}${n}%`

/**
 * Issue #88: early in a month, a projection extrapolates from few complete
 * days and can swing wildly (+206%, +1230% on Nov 6). Below this many
 * complete days a projected change is marked low-confidence, and above
 * PROJECTED_CHANGE_CAP it is shown capped (">+100%"). Actuals are unchanged.
 */
export const LOW_CONFIDENCE_DAYS = 10
export const PROJECTED_CHANGE_CAP = 100

/** True when the projection rests on fewer than LOW_CONFIDENCE_DAYS complete days. */
export function isLowConfidence(basis: Pick<ProjectionBasis, "completeDays"> | null | undefined): boolean {
  return (basis?.completeDays ?? 0) < LOW_CONFIDENCE_DAYS
}

/** The percent text for a projected change: capped at ">+100%" when low-confidence. */
export function projectedPercentText(changePercent: number, basis?: Pick<ProjectionBasis, "completeDays"> | null): string {
  if (basis !== undefined && isLowConfidence(basis) && changePercent > PROJECTED_CHANGE_CAP) return `>+${PROJECTED_CHANGE_CAP}%`
  return signed(changePercent)
}

/** Tooltip suffix for a low-confidence projection. */
export function lowConfidenceNote(basis: Pick<ProjectionBasis, "completeDays"> | null | undefined): string {
  const n = basis?.completeDays ?? 0
  return `Low confidence: only ${n} complete day${n === 1 ? "" : "s"} so far (under ${LOW_CONFIDENCE_DAYS}); early-month projections can swing widely. Changes over +${PROJECTED_CHANGE_CAP}% are shown capped. Actual to date is exact.`
}

/** "+0.7% projected", "new" (no prior spend), for a projected change. With a basis, capped when low-confidence. */
export function projectedChangeLabel(changePercent: number | null | undefined, basis?: Pick<ProjectionBasis, "completeDays"> | null): string {
  if (changePercent === null || changePercent === undefined) return "new"
  return `${projectedPercentText(changePercent, basis)} projected`
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

/**
 * Issue #88: a readable label for an inclusive YYYY-MM-DD period: "October 2026"
 * for a whole calendar month, else "Oct 5 – Nov 3, 2026".
 */
export function formatPeriodLabel(start: string, end: string): string {
  const ym = start.slice(0, 7)
  const [y, m] = ym.split("-").map(Number)
  if (y && m && start === `${ym}-01` && end.slice(0, 7) === ym) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    if (end === `${ym}-${String(last).padStart(2, "0")}`) return formatMonthLong(ym)
  }
  return formatRangeLabel(start, end)
}

/** "2026-10-01" -> "Oct 1, 2026". */
export function formatDayLabel(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
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
        current.changePercent === null
          ? "new"
          : `${projectedPercentText(current.changePercent, current)} vs ${formatMonthLabel(current.prevMonth)}`
      return `Projected ${formatMonthLabel(current.month)}: ${formatCurrency(current.projected)} (${change}); ${avg}`
    }
    return `No forecast for this view; ${avg}`
  }
  if (!hasProjection) return "History only for this view"
  return "History (solid) with trend projection (dashed)"
}
