/**
 * Dashboard data API — real aggregation over cost_records for the v0-style UI.
 *
 * GET /api/dashboard[?month=YYYY-MM]
 *
 * Returns everything the dashboard renders, computed from the automated
 * cost_records data (via the cost_records_daily rollup) — no manual/mock data:
 *  - months:        available months (YYYY-MM), newest first
 *  - selectedMonth: the month being shown
 *  - tools:         per-provider spend for the selected month (+ MoM change)
 *  - trends:        total spend per month (with per-provider breakdown)
 *  - byModel:       top models by spend for the selected month
 *  - kpis:          totals and deltas
 *  - forecast:      real history plus a trend projection (flagged projected)
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"

export const dynamic = "force-dynamic"

// Liatrio brand palette (matches the v0 design).
const PALETTE = [
  "#00A94F", "#3B82F6", "#06B6D4", "#8B5CF6",
  "#14B8A6", "#F97316", "#F59E0B", "#DC2626", "#6B7280",
]

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length]
}

function formatTokens(n: number): string {
  if (!n) return "—"
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B tokens`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tokens`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K tokens`
  return `${n} tokens`
}

interface DailyRow {
  date: string
  provider_id: string
  model_name: string
  total_cost_usd: number
  total_tokens: number | null
  total_requests: number | null
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore) // shared org-wide view; gate on login only
    const supabase = await createClient(cookieStore)

    // Providers: id -> display name / slug / order
    const { data: providersRaw, error: provErr } = await supabase
      .from("providers")
      .select("id, name, display_name, metadata")
      .order("display_name")
    if (provErr) throw provErr
    const providers = (providersRaw || []) as any[]
    const providerById = new Map<string, { name: string; slug: string; color: string; subscriptionType: string }>()
    providers.forEach((p, i) => {
      const method = (p.metadata?.collection_method as string) || "api"
      providerById.set(p.id, {
        name: p.display_name || p.name,
        slug: p.name,
        color: colorFor(i),
        subscriptionType: method === "manual" ? "Manual / CSV" : "Usage (API)",
      })
    })

    // Pull the daily rollup (real automated data).
    const { data: dailyRaw, error: dailyErr } = await supabase
      .from("cost_records_daily")
      .select("date, provider_id, model_name, total_cost_usd, total_tokens, total_requests")
      .order("date", { ascending: true })
    if (dailyErr) throw dailyErr
    const daily = (dailyRaw || []) as DailyRow[]

    const monthOf = (d: string) => d.slice(0, 7) // YYYY-MM

    // month -> provider_id -> {cost, tokens}
    const byMonthProvider = new Map<string, Map<string, { cost: number; tokens: number }>>()
    // month -> total cost
    const monthTotals = new Map<string, number>()
    // month -> model -> cost (for selected-month model breakdown)
    const byMonthModel = new Map<string, Map<string, number>>()

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

      if (!byMonthModel.has(m)) byMonthModel.set(m, new Map())
      const mm = byMonthModel.get(m)!
      mm.set(r.model_name, (mm.get(r.model_name) || 0) + cost)
    }

    const months = Array.from(monthTotals.keys()).sort().reverse() // newest first
    const requested = request.nextUrl.searchParams.get("month")
    const selectedMonth = (requested && months.includes(requested) ? requested : months[0]) || monthOf(new Date().toISOString())

    // Previous month string for MoM change
    const prevOf = (ym: string) => {
      const [y, mo] = ym.split("-").map(Number)
      const d = new Date(y, mo - 2, 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    }
    const prevMonth = prevOf(selectedMonth)

    // tools: per provider for the selected month
    const curPM = byMonthProvider.get(selectedMonth) || new Map()
    const prevPM = byMonthProvider.get(prevMonth) || new Map()
    const tools = Array.from(curPM.entries())
      .map(([pid, agg]) => {
        const meta = providerById.get(pid) || { name: "Unknown", slug: pid, color: "#6B7280", subscriptionType: "" }
        const prev = prevPM.get(pid)?.cost || 0
        let changePercent = 0
        let changeDirection: "up" | "down" | "stable" = "stable"
        if (prev > 0 && agg.cost > 0) {
          changePercent = Math.round(((agg.cost - prev) / prev) * 100)
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
        }
      })
      .sort((a, b) => b.monthlySpend - a.monthlySpend)

    // trends: total per month + per-provider series
    const trends = Array.from(monthTotals.keys())
      .sort()
      .map((m) => {
        const pm = byMonthProvider.get(m) || new Map()
        const row: Record<string, any> = { month: m, total: Math.round((monthTotals.get(m) || 0) * 100) / 100 }
        for (const [pid, agg] of pm.entries()) {
          const meta = providerById.get(pid)
          if (meta) row[meta.slug] = Math.round(agg.cost * 100) / 100
        }
        return row
      })

    // byModel: top models for the selected month
    const modelMap = byMonthModel.get(selectedMonth) || new Map()
    const byModel = Array.from(modelMap.entries())
      .map(([model, cost]) => ({ model, total: Math.round(cost * 100) / 100 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
      .map((row, i) => ({ ...row, color: colorFor(i) }))

    // KPIs
    const totalSpend = monthTotals.get(selectedMonth) || 0
    const prevSpend = monthTotals.get(prevMonth) || 0
    const totalTokens = Array.from(curPM.values()).reduce((s, a) => s + a.tokens, 0)
    const changePercent = prevSpend > 0 ? Math.round(((totalSpend - prevSpend) / prevSpend) * 100) : 0
    const kpis = {
      totalSpend: Math.round(totalSpend * 100) / 100,
      prevSpend: Math.round(prevSpend * 100) / 100,
      changePercent,
      totalTokens,
      activeProviders: curPM.size,
      topProvider: tools[0]?.name || "—",
    }

    // forecast: real history + a simple 3-month linear projection from the last
    // up-to-6 months of real totals (flagged projected). Prefer stored
    // forecast_results if present.
    const history = Array.from(monthTotals.keys()).sort().map((m) => ({
      month: m,
      total: Math.round((monthTotals.get(m) || 0) * 100) / 100,
      projected: false,
    }))
    const forecast = [...history]
    const tail = history.slice(-6)
    if (tail.length >= 2) {
      // average month-over-month delta
      let deltas = 0
      for (let i = 1; i < tail.length; i++) deltas += tail[i].total - tail[i - 1].total
      const avgDelta = deltas / (tail.length - 1)
      let last = tail[tail.length - 1]
      let cursor = last.month
      let value = last.total
      for (let i = 0; i < 3; i++) {
        const [y, mo] = cursor.split("-").map(Number)
        const d = new Date(y, mo, 1) // next month
        cursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
        value = Math.max(0, Math.round((value + avgDelta) * 100) / 100)
        forecast.push({ month: cursor, total: value, projected: true })
      }
    }

    return successResponse({
      months,
      selectedMonth,
      tools,
      trends,
      byModel,
      kpis,
      forecast,
    })
  } catch (error: any) {
    if (error?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    console.error("GET /api/dashboard error:", error)
    return errorResponse(error?.message || "Failed to load dashboard data", 500)
  }
}
