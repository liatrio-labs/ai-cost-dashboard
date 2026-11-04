/**
 * Issue #39 end to end on its own shape: a full October, Nov 1 (Sunday) to
 * Nov 3 complete, Nov 4 partial, OpenAI lagging a day, ChatGPT not yet billed
 * and Claude Ultra seats billed on the 1st (lib/projection-fixtures.ts).
 */

import { readFileSync } from "fs"
import { join } from "path"
import { computeDashboard } from "@/lib/dashboard-compute"
import { applyFilters, type DashboardFilters } from "@/lib/dashboard-filters"
import { forecastDescription, type DashboardTrend } from "@/lib/dashboard-types"
import { FORECAST_DEFAULTS, plateauForEmployees } from "@/lib/forecast-settings"
import { trendSeries, forecastSeries } from "@/lib/chart-series"
import { computeBreakdown } from "@/lib/org/breakdown"
import { computeUnitForecasts } from "@/lib/unit-forecast"
import { projectionContext } from "@/lib/projection"
import { totalsSnapshot } from "@/lib/totals-snapshot"
import { DD, KK, NOW_39, PP, PROVIDERS_39, PV, TT, org39, plainRows39, rows39 } from "@/lib/projection-fixtures"

const S = FORECAST_DEFAULTS
const dashboard = (filters: DashboardFilters = {}, params: { month?: string; start?: string; end?: string } = { month: "2026-11" }) => {
  const providerId = filters.provider ? (PROVIDERS_39.find((p) => p.name === filters.provider)?.id ?? null) : null
  const filtered = Object.keys(filters).length > 0
  return computeDashboard({
    daily: filtered ? applyFilters(rows39(), filters, providerId) : plainRows39(),
    providers: PROVIDERS_39,
    params,
    forecastSettings: S,
    now: NOW_39,
    projectForecast: !filtered,
  })
}
const breakdown = (filters: DashboardFilters = {}, params: { month?: string; start?: string; end?: string } = { month: "2026-11" }) =>
  computeBreakdown({ rows: rows39(), org: org39(), providers: PROVIDERS_39, filters, params, now: NOW_39 })

describe("issue #39 fixture: KPIs", () => {
  it("the old change % reads as a collapse; the projected change sits near the prior month", () => {
    const d = dashboard()
    // Old: partial November vs October (unchanged, still reported).
    expect(d.kpis.changePercent).toBeLessThan(-85)
    const b = breakdown()
    expect(b.total.changePercent!).toBeLessThan(-85)

    // New: projected November vs full October.
    expect(d.projection.status).toBe("current")
    expect(d.projection.compare).toEqual({ start: "2026-10-01", end: "2026-10-31" })
    const k = d.projection.kpis!
    expect(k.actualToDate).toBe(d.kpis.totalSpend)
    expect(k.compareSpend).toBe(b.total.prevCost)
    expect(Math.abs(k.changePercent!)).toBeLessThan(15)
    expect(b.projection.total!.projectedChangePercent).toBe(k.changePercent)
    // OpenAI lags: the basis is its 2 complete days.
    expect(d.projection.basis).toEqual({ completeDays: 2, completeThrough: "2026-11-02" })
  })

  it("ChatGPT (billed Oct 1, not yet in November) is in the projection at $900", () => {
    const gpt = dashboard({ provider: "chatgpt" })
    expect(gpt.kpis.totalSpend).toBe(0)
    expect(gpt.projection.kpis).toMatchObject({ projectedSpend: 900, compareSpend: 900, changePercent: 0 })
  })

  it("tools: each provider's change is projected", () => {
    const d = dashboard()
    for (const t of d.tools) {
      expect(t.projectedSpend).toBeGreaterThanOrEqual(t.monthlySpend)
      expect(Math.abs(t.projectedChangePercent!)).toBeLessThan(20)
    }
    const max = d.tools.find((t) => t.id === PV.claudeMax)!
    expect(max).toMatchObject({ monthlySpend: 400, projectedSpend: 400, projectedChangePercent: 0 })
  })

  it("past months keep actual vs actual; future periods have no projection", () => {
    const oct = dashboard({}, { month: "2026-10" })
    expect(oct.projection).toMatchObject({ status: "past", kpis: null, basis: null })
    expect(oct.tools.every((t) => t.projectedSpend === undefined)).toBe(true)
    const dec = dashboard({}, { start: "2026-12-01", end: "2026-12-31" })
    expect(dec.projection).toMatchObject({ status: "future", kpis: null })
    expect(dec.kpis.totalSpend).toBe(0)
    const b = breakdown({}, { month: "2026-10" })
    expect(b.projection.status).toBe("past")
    expect(b.person.every((e) => e.projectedCost === null && e.projectedChangePercent === null)).toBe(true)
  })
})

describe("issue #39 fixture: org tables", () => {
  const b = breakdown()
  const at = <T extends { key: string }>(es: T[], key: string) => es.find((e) => e.key === key)!

  it("person, team, department, key and project rows carry a projected change vs the previous full month", () => {
    const heavy = at(b.person, PP.heavy)
    expect(heavy.changePercent!).toBeLessThan(-85)
    expect(Math.abs(heavy.projectedChangePercent!)).toBeLessThan(15)
    expect(Math.abs(at(b.team, TT.core).projectedChangePercent!)).toBeLessThan(15)
    expect(Math.abs(at(b.department, DD.eng).projectedChangePercent!)).toBeLessThan(15)
    expect(Math.abs(at(b.api_key, KK.heavy).projectedChangePercent!)).toBeLessThan(15)
    expect(b.project.find((p) => p.unassigned)!.projectedCost).toBe(b.projection.total!.projectedCost)
    // key_groups rows show the same numbers as the API keys table.
    const listed = b.key_groups.flatMap((g) => g.projects.flatMap((p) => p.keys))
    const item = listed.find((k) => k.key === KK.heavy)!
    expect(item.projectedChangePercent).toBe(at(b.api_key, KK.heavy).projectedChangePercent)
  })

  it("seat-only person: projection equals the seat amount", () => {
    expect(at(b.person, PP.seat)).toMatchObject({ cost: 200, prevCost: 200, projectedCost: 200, projectedChangePercent: 0 })
  })

  it("new person: projected spend and 'new' (no %)", () => {
    const n = at(b.person, PP.fresh)
    expect(n.prevCost).toBe(0)
    expect(n.projectedCost!).toBeGreaterThan(n.cost)
    expect(n.projectedChangePercent).toBeNull()
  })

  it("the org-level ChatGPT seat lands in Unassigned's projection", () => {
    const u = at(b.person, "unassigned")
    expect(u).toMatchObject({ cost: 0, prevCost: 900, projectedCost: 900, projectedChangePercent: 0 })
  })
})

describe("issue #39 fixture: charts", () => {
  it("Spend Trends: solid through October, dotted from October to projected November", () => {
    const d = dashboard()
    const cm = d.projection.currentMonth!
    expect(cm).toMatchObject({ month: "2026-11", prevMonth: "2026-10", actualToDate: d.trends.at(-1)!.total })
    const s = trendSeries(d.trends as DashboardTrend[], cm)
    const solid = s.filter((p) => p.actual !== null)
    expect(solid.at(-1)!.ym).toBe("2026-10")
    expect(solid.some((p) => p.ym === "2026-11")).toBe(false)
    const dotted = s.filter((p) => p.projected !== null)
    expect(dotted.map((p) => p.ym)).toEqual(["2026-10", "2026-11"])
    expect(dotted[0].projected).toBe(dotted[0].actual)
    expect(dotted[1]).toMatchObject({ projected: cm.projected, actualToDate: cm.actualToDate })
    // The trends data itself still has November's actual.
    expect(d.trends.find((t) => t.month === "2026-11")!.total).toBe(cm.actualToDate)
  })

  it("Spend Forecast: anchored on projected November, saturating to December", () => {
    const d = dashboard()
    const cm = d.projection.currentMonth!
    const ceiling = plateauForEmployees(S)
    expect(d.forecast).toEqual([
      { month: "2026-09", total: d.trends[0].total, projected: false },
      { month: "2026-10", total: d.trends[1].total, projected: false },
      { month: "2026-11", total: cm.projected, projected: true, actualToDate: cm.actualToDate },
      { month: "2026-12", total: Math.round((cm.projected + (ceiling - cm.projected) * 0.45) * 100) / 100, projected: true },
    ])
    const s = forecastSeries(d.forecast)
    expect(s.filter((p) => p.actual !== null).map((p) => p.ym)).toEqual(["2026-09", "2026-10"])
    expect(s.filter((p) => p.projected !== null).map((p) => p.ym)).toEqual(["2026-10", "2026-11", "2026-12"])
    expect(s[2].actualToDate).toBe(cm.actualToDate)
  })

  it("team forecasts start from the same projected current month, and sum to the org", () => {
    const ctx = projectionContext(PROVIDERS_39, NOW_39)
    const r = computeUnitForecasts({ rows: rows39(), level: "team", settings: S, current: ctx })
    expect(r.anchorMonth).toBe("2026-11")
    const core = r.units.find((u) => u.key === TT.core)!
    const coreDash = computeDashboard({
      daily: applyFilters(rows39(), { team: TT.core }),
      providers: PROVIDERS_39,
      params: { month: "2026-11" },
      forecastSettings: S,
      now: NOW_39,
      projectForecast: false,
      unitForecast: core,
    })
    expect(coreDash.forecast.find((f) => f.month === "2026-11")).toMatchObject({ projected: true, total: core.anchor })
    expect(coreDash.forecast.find((f) => f.month === "2026-12")!.total).toBe(core.projection[0].total)
    const dec = r.units.reduce((s, u) => s + u.projection[0].total, 0)
    expect(Math.abs(dec - r.orgProjection[0].total)).toBeLessThanOrEqual(1)
    // The unit anchors sum to the org's projected November.
    const anchors = r.units.reduce((s, u) => s + u.anchor, 0)
    expect(Math.abs(anchors - dashboard().projection.currentMonth!.projected)).toBeLessThanOrEqual(1)
  })

  it("person view: forecast card shows the projected current month, not 'No forecast'", () => {
    const d = dashboard({ person: PP.heavy })
    const cm = d.projection.currentMonth!
    expect(d.forecast.filter((f) => f.projected).map((f) => f.month)).toEqual(["2026-11"])
    expect(Math.abs(cm.changePercent!)).toBeLessThan(15)
    const text = forecastDescription({ ...d.forecastMeta, trailingAverage: 123 }, undefined, true, cm)
    expect(text).toMatch(/^Projected Nov 2026: \$[\d,]+\.\d\d \([+-][\d.]+% vs Oct 2026\); trailing 3-month average \$123\.00\/mo$/)
    expect(forecastDescription({ ...d.forecastMeta, trailingAverage: 0 }, undefined, true, { ...cm, changePercent: null })).toContain("(new)")
  })
})

describe("totals unchanged (issue #39)", () => {
  // Captured from main before projections were added (lib/totals-snapshot.ts).
  const baseline = JSON.parse(readFileSync(join(__dirname, "projection-totals-baseline.json"), "utf8")) as Record<string, unknown>
  const now = totalsSnapshot()
  it("covers the same cases", () => {
    expect(Object.keys(now).sort()).toEqual(Object.keys(baseline).sort())
    expect(Object.keys(baseline).length).toBeGreaterThan(40)
  })
  it.each(Object.keys(baseline))("%s", (id) => {
    expect(now[id]).toEqual(baseline[id])
  })
})
