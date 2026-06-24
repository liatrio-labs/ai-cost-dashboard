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

export interface DashboardData {
  months: string[]
  selectedMonth: string
  tools: DashboardTool[]
  trends: DashboardTrend[]
  byModel: DashboardByModel[]
  kpis: DashboardKpis
  forecast: DashboardForecast[]
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
