/**
 * Pure aggregation behind GET /api/dashboard, moved out of the route so it can
 * be tested with fixture rows. The logic is unchanged from the original route;
 * additions are `projectForecast` (off when filters narrow the data below the
 * org) and `unitForecast` (#9: a team/department filter projects that unit).
 */

import { plateauForEmployees, type ForecastSettings } from "@/lib/forecast-settings"
import { orgProjection, type UnitForecast } from "@/lib/unit-forecast"

// Liatrio brand palette (https://www.liatrio.ai/brand-data.json).
const PALETTE = [
  "#24AE1D", // Primary Green
  "#00C1DB", // Lagoon
  "#C068F9", // Violet
  "#F77F00", // Flame Orange
  "#89DF00", // Bright Green
  "#006989", // Deep Sea
  "#E63946", // Hot Red
  "#C6F135", // Lime
  "#666666", // Grey 500
]

export function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length]
}

function formatTokens(n: number): string {
  if (!n) return "—"
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B tokens`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tokens`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K tokens`
  return `${n} tokens`
}

/** A cost_records_daily (or cost_records_daily_attributed) row. */
export interface DailyRow {
  date: string
  provider_id: string
  model_name: string
  total_cost_usd: number | string
  total_tokens?: number | string | null
  total_requests?: number | string | null
}

/** A providers row, as selected by the dashboard routes. */
export interface ProviderRow {
  id: string
  name: string
  display_name: string | null
  documentation_url?: string | null
  last_collected_at?: string | null
  metadata?: Record<string, unknown> | null
}

export interface ProviderMeta {
  name: string
  slug: string
  color: string
  subscriptionType: string
  description: string
  adminUrl: string
  lastUpdated: string | null
}

/** Providers are expected in display_name order (as the route selects them). */
export function buildProviderMeta(providers: ProviderRow[]): Map<string, ProviderMeta> {
  const providerById = new Map<string, ProviderMeta>()
  providers.forEach((p, i) => {
    const method = (p.metadata?.collection_method as string) || "api"
    providerById.set(p.id, {
      name: p.display_name || p.name,
      slug: p.name,
      color: colorFor(i),
      subscriptionType: method === "manual" ? "Manual / CSV" : "Usage (API)",
      description: (p.metadata?.description as string) || "",
      adminUrl: (p.documentation_url as string) || "",
      lastUpdated: (p.last_collected_at as string) || null,
    })
  })
  return providerById
}

export interface PeriodParams {
  month?: string | null
  start?: string | null
  end?: string | null
}

export interface ResolvedPeriod {
  start: string
  end: string
  mode: "month" | "range"
  selectedMonth: string | null
}

const monthOf = (d: string) => d.slice(0, 7) // YYYY-MM

export function monthBounds(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, "0")}` }
}

export const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10)

/** Active period: custom range (start+end) | a month | default current month. */
export function resolvePeriod(params: PeriodParams, now: Date = new Date()): ResolvedPeriod {
  const { start: startParam, end: endParam, month: monthParam } = params
  if (startParam && endParam) {
    return {
      start: startParam < endParam ? startParam : endParam,
      end: startParam < endParam ? endParam : startParam,
      mode: "range",
      selectedMonth: null,
    }
  }
  const ym = monthParam || monthOf(now.toISOString()) // default: current month
  const b = monthBounds(ym)
  return { start: b.start, end: b.end, mode: "month", selectedMonth: ym }
}

/** Previous equal-length window (what the KPI change % compares against). */
export function previousWindow(start: string, end: string): { start: string; end: string } {
  const periodLen = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1)
  return { start: addDays(start, -periodLen), end: addDays(start, -1) }
}

export interface ComputeDashboardInput {
  daily: DailyRow[]
  providers: ProviderRow[]
  params: PeriodParams
  forecastSettings: ForecastSettings
  now?: Date
  /** Default true. Off when filters narrow the data below the org. */
  projectForecast?: boolean
  /** Team/department filter: project this unit instead of the org (issue #9). */
  unitForecast?: UnitForecast | null
  /** Person/key filters: trailing 3-month average shown instead of a forecast. */
  trailingAverage?: number
}

export interface UnitForecastMeta {
  level: UnitForecast["level"]
  key: string
  unassigned: boolean
  share: number
  trailingSpend: number
  allocatedPlateau: number
  plateau: number
  override: UnitForecast["override"]
}

function unitForecastMeta(u: UnitForecast): UnitForecastMeta {
  return {
    level: u.level,
    key: u.key,
    unassigned: u.unassigned,
    share: Math.round(u.share * 10000) / 10000,
    trailingSpend: u.trailingSpend,
    allocatedPlateau: u.allocatedPlateau,
    plateau: u.plateau,
    override: u.override,
  }
}

export function computeDashboard({
  daily,
  providers,
  params,
  forecastSettings,
  now = new Date(),
  projectForecast = true,
  unitForecast = null,
  trailingAverage,
}: ComputeDashboardInput) {
  const providerById = buildProviderMeta(providers)

  // month -> provider_id -> {cost, tokens}
  const byMonthProvider = new Map<string, Map<string, { cost: number; tokens: number }>>()
  // month -> total cost
  const monthTotals = new Map<string, number>()

  for (const r of daily) {
    const m = monthOf(r.date)
    const cost = Number(r.total_cost_usd) || 0
    const tokens = Number(r.total_tokens) || 0

    if (!byMonthProvider.has(m)) byMonthProvider.set(m, new Map())
    const pm = byMonthProvider.get(m)!
    const cur = pm.get(r.provider_id) || { cost: 0, tokens: 0 }
    cur.cost += cost
    cur.tokens += tokens
    pm.set(r.provider_id, cur)

    monthTotals.set(m, (monthTotals.get(m) || 0) + cost)
  }

  const months = Array.from(monthTotals.keys()).sort().reverse() // newest first

  // Date coverage (so the range picker knows how far back data goes)
  const sortedDates = daily.map((r) => r.date).sort()
  const dataStart = sortedDates[0] || null
  const dataEnd = sortedDates[sortedDates.length - 1] || null

  const period = resolvePeriod(params, now)
  const { start: periodStart, end: periodEnd, mode, selectedMonth } = period

  // Aggregate the daily rows within an inclusive [start, end] date window.
  const aggregate = (start: string, end: string) => {
    const prov = new Map<string, { cost: number; tokens: number }>()
    const model = new Map<string, number>()
    let total = 0
    let tokens = 0
    for (const r of daily) {
      if (r.date < start || r.date > end) continue
      const cost = Number(r.total_cost_usd) || 0
      const tok = Number(r.total_tokens) || 0
      const p = prov.get(r.provider_id) || { cost: 0, tokens: 0 }
      p.cost += cost
      p.tokens += tok
      prov.set(r.provider_id, p)
      model.set(r.model_name, (model.get(r.model_name) || 0) + cost)
      total += cost
      tokens += tok
    }
    return { prov, model, total, tokens }
  }

  const cur = aggregate(periodStart, periodEnd)
  // Previous equal-length window, for the change %.
  const prevWin = previousWindow(periodStart, periodEnd)
  const prev = aggregate(prevWin.start, prevWin.end)

  // tools: per provider for the active period
  const tools = Array.from(cur.prov.entries())
    .map(([pid, agg]) => {
      const meta = providerById.get(pid) || { name: "Unknown", slug: pid, color: "#6B7280", subscriptionType: "", description: "", adminUrl: "", lastUpdated: null }
      const prevCost = prev.prov.get(pid)?.cost || 0
      let changePercent = 0
      let changeDirection: "up" | "down" | "stable" = "stable"
      if (prevCost > 0 && agg.cost > 0) {
        changePercent = Math.round(((agg.cost - prevCost) / prevCost) * 100)
        if (changePercent > 5) changeDirection = "up"
        else if (changePercent < -5) changeDirection = "down"
      }
      return {
        id: pid,
        name: meta.name,
        monthlySpend: Math.round(agg.cost * 100) / 100,
        usageVolume: formatTokens(agg.tokens),
        change: changeDirection,
        changePercent: Math.abs(changePercent),
        changeDirection,
        subscriptionType: meta.subscriptionType,
        color: meta.color,
        description: meta.description,
        adminUrl: meta.adminUrl,
        lastUpdated: meta.lastUpdated,
      }
    })
    .sort((a, b) => b.monthlySpend - a.monthlySpend)

  // trends: total per month + per-provider series
  const trends = Array.from(monthTotals.keys())
    .sort()
    .map((m) => {
      const pm = byMonthProvider.get(m) || new Map()
      const row: Record<string, string | number> = { month: m, total: Math.round((monthTotals.get(m) || 0) * 100) / 100 }
      for (const [pid, agg] of pm.entries()) {
        const meta = providerById.get(pid)
        if (meta) row[meta.slug] = Math.round(agg.cost * 100) / 100
      }
      return row
    })

  // byModel: top models for the active period
  const byModel = Array.from(cur.model.entries())
    .map(([model, cost]) => ({ model, total: Math.round(cost * 100) / 100 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
    .map((row, i) => ({ ...row, color: colorFor(i) }))

  // KPIs (active period vs the preceding equal-length window)
  const changePercent = prev.total > 0 ? Math.round(((cur.total - prev.total) / prev.total) * 100) : 0
  const kpis = {
    totalSpend: Math.round(cur.total * 100) / 100,
    prevSpend: Math.round(prev.total * 100) / 100,
    changePercent,
    totalTokens: cur.tokens,
    activeProviders: cur.prov.size,
    topProvider: tools[0]?.name || "—",
  }

  // forecast: real history + a SATURATING projection through end of the
  // current year. Spend has been ramping fast, but is expected to plateau, so
  // instead of a runaway linear trend we close a fixed fraction of the gap to
  // a ceiling each month — the curve levels out near the ceiling by Dec.
  //
  // The ceiling is HEADCOUNT-DRIVEN: at the baseline employee count the
  // plateau is the baseline USD, and each employee above/below scales it by
  // per_person_pct (default 2%). Editable from the admin page (app_settings).
  const FORECAST_CEILING = plateauForEmployees(forecastSettings)
  const history = Array.from(monthTotals.keys()).sort().map((m) => ({
    month: m,
    total: Math.round((monthTotals.get(m) || 0) * 100) / 100,
    projected: false,
  }))
  const forecast: { month: string; total: number; projected: boolean }[] = [...history]
  if (unitForecast) {
    // A team/department filter: that unit's projection (lib/unit-forecast.ts).
    for (const p of unitForecast.projection) forecast.push({ ...p, projected: true })
  } else if (projectForecast && history.length >= 1) {
    // Anchor on the recent run-rate (max of the last two real months) and
    // close FORECAST_APPROACH of the gap to the ceiling each month through
    // December. See orgProjection in lib/unit-forecast.ts.
    for (const p of orgProjection(history, FORECAST_CEILING)) forecast.push({ ...p, projected: true })
  }

  return {
    months,
    selectedMonth,
    dataStart,
    dataEnd,
    period: { start: periodStart, end: periodEnd, mode },
    tools,
    trends,
    byModel,
    kpis,
    forecast,
    forecastMeta: {
      employees: forecastSettings.employees,
      plateau: Math.round(FORECAST_CEILING * 100) / 100,
      perPersonPct: forecastSettings.perPersonPct,
      baselineEmployees: forecastSettings.baselineEmployees,
      ...(unitForecast ? { unit: unitForecastMeta(unitForecast) } : {}),
      ...(trailingAverage !== undefined ? { trailingAverage } : {}),
    },
  }
}
