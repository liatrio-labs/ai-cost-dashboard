/**
 * Pure aggregation behind GET /api/dashboard, extracted from the route so the
 * unfiltered (cost_records_daily) and filtered (cost_records_daily_attributed)
 * paths share one implementation. Behaviour is unchanged from the original
 * route; app/api/dashboard/__tests__/route.test.ts pins it with a snapshot.
 */

import type { PeriodParams } from "./filters"
import { monthOf, precedingWindow, resolvePeriod } from "./period"

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

export interface DailyRow {
  date: string
  provider_id: string
  model_name: string
  total_cost_usd: number | string
  total_tokens?: number | string | null
  total_requests?: number | string | null
}

export interface ProviderRow {
  id: string
  name: string
  display_name?: string | null
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

/** providers rows (ordered by display_name) -> display metadata with stable colors. */
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

export interface ForecastInputs {
  ceiling: number
  meta: Record<string, unknown>
}

export function buildDashboardData(
  daily: DailyRow[],
  providers: ProviderRow[],
  periodParams: PeriodParams,
  forecastInputs: ForecastInputs,
  now: Date = new Date()
) {
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

  // Active period: custom range (start+end) | a month | default current month.
  const period = resolvePeriod(periodParams, now)
  const periodStart = period.start
  const periodEnd = period.end

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
  const prevWindow = precedingWindow(periodStart, periodEnd)
  const prev = aggregate(prevWindow.start, prevWindow.end)

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
      const row: Record<string, number | string> = { month: m, total: Math.round((monthTotals.get(m) || 0) * 100) / 100 }
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
  // The ceiling is HEADCOUNT-DRIVEN (see lib/forecast-settings).
  const FORECAST_CEILING = forecastInputs.ceiling
  const FORECAST_APPROACH = 0.45 // fraction of the remaining gap closed per month
  const history = Array.from(monthTotals.keys()).sort().map((m) => ({
    month: m,
    total: Math.round((monthTotals.get(m) || 0) * 100) / 100,
    projected: false,
  }))
  const forecast = [...history]
  if (history.length >= 1) {
    const lastMonth = history[history.length - 1].month
    // Anchor on the recent run-rate. The current calendar month is usually
    // incomplete, so its total understates the run-rate — use the max of the
    // last two real months so the projection starts from the true level.
    const anchor =
      history.length >= 2
        ? Math.max(history[history.length - 1].total, history[history.length - 2].total)
        : history[history.length - 1].total

    const endOfYear = `${lastMonth.slice(0, 4)}-12` // December of the last data year
    let cursor = lastMonth
    let value = anchor
    // Safety cap on iterations (max 12 future months).
    for (let i = 0; i < 12 && cursor < endOfYear; i++) {
      const [y, mo] = cursor.split("-").map(Number)
      const d = new Date(Date.UTC(y, mo, 1)) // first of the next month
      cursor = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
      value = value + (FORECAST_CEILING - value) * FORECAST_APPROACH
      forecast.push({ month: cursor, total: Math.round(value * 100) / 100, projected: true })
    }
  }

  return {
    months,
    selectedMonth: period.selectedMonth,
    dataStart,
    dataEnd,
    period: { start: periodStart, end: periodEnd, mode: period.mode },
    tools,
    trends,
    byModel,
    kpis,
    forecast,
    forecastMeta: forecastInputs.meta,
  }
}
