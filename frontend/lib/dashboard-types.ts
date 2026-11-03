/**
 * Shared types for the dashboard UI, mirroring the GET /api/dashboard contract.
 * Components are presentational and consume these via props.
 */

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
export function forecastDescription(meta?: DashboardForecastMeta, unitLabel?: string, hasProjection = true): string {
  const u = meta?.unit
  if (u) {
    const name = unitLabel || (u.unassigned ? "Unassigned" : u.level === "team" ? "this team" : "this department")
    const basis = u.override
      ? `admin ${u.override} override`
      : `${(u.share * 100).toFixed(1)}% of trailing 3-month org spend`
    return `${name}: plateau ${formatCurrency(u.plateau)}/mo (${basis})`
  }
  if (meta?.trailingAverage !== undefined) {
    return `No forecast for this view; trailing 3-month average ${formatCurrency(meta.trailingAverage)}/mo`
  }
  if (!hasProjection) return "History only for this view"
  return "History (solid) with trend projection (dashed)"
}
