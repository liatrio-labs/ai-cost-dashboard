/**
 * Recharts series for Spend Trends / Spend Forecast and the projected-change
 * labels (issue #39).
 */

import { forecastSeries, trendSeries } from "./chart-series"
import { projectedChangeLabel, projectionTooltip, type CurrentMonthProjection, type DashboardProjection } from "./dashboard-types"
import { spendChange } from "@/components/kpi-cards"
import { toolChange } from "@/components/tools-table"
import { changeCell } from "@/components/org/org-breakdown"

const cm = (over: Partial<CurrentMonthProjection> = {}): CurrentMonthProjection => ({
  month: "2026-11",
  projected: 120,
  actualToDate: 9,
  prevMonth: "2026-10",
  prevTotal: 136,
  changePercent: -11.8,
  completeDays: 3,
  completeThrough: "2026-11-03",
  ...over,
})
const trends = [
  { month: "2026-09", total: 80 },
  { month: "2026-10", total: 136 },
  { month: "2026-11", total: 9 },
]

describe("trendSeries", () => {
  it("without a projection, every month is solid (unchanged)", () => {
    const s = trendSeries(trends, null)
    expect(s.map((p) => [p.ym, p.actual, p.projected])).toEqual([
      ["2026-09", 80, null],
      ["2026-10", 136, null],
      ["2026-11", 9, null],
    ])
  })

  it("the last complete month is the last solid point; the dotted series starts there; no partial month is solid", () => {
    const s = trendSeries(trends, cm())
    expect(s.map((p) => [p.ym, p.actual, p.projected])).toEqual([
      ["2026-09", 80, null],
      ["2026-10", 136, 136],
      ["2026-11", null, 120],
    ])
    expect(s[2].actualToDate).toBe(9)
    expect(s[2].month).toBe("Nov 2026")
  })

  it("no rows yet this month still gets the projected point; a first month has no solid line", () => {
    expect(trendSeries(trends.slice(0, 2), cm()).map((p) => [p.ym, p.actual, p.projected])).toEqual([
      ["2026-09", 80, null],
      ["2026-10", 136, 136],
      ["2026-11", null, 120],
    ])
    expect(trendSeries([{ month: "2026-11", total: 9 }], cm()).map((p) => [p.ym, p.actual, p.projected])).toEqual([["2026-11", null, 120]])
  })
})

describe("forecastSeries", () => {
  it("joins the dotted line to the last actual month", () => {
    const s = forecastSeries([
      { month: "2026-10", total: 136, projected: false },
      { month: "2026-11", total: 120, projected: true, actualToDate: 9 },
      { month: "2026-12", total: 150, projected: true },
    ])
    expect(s.map((p) => [p.ym, p.actual, p.projected])).toEqual([
      ["2026-10", 136, 136],
      ["2026-11", null, 120],
      ["2026-12", null, 150],
    ])
    expect(s[1].actualToDate).toBe(9)
    expect(s[2].actualToDate).toBeUndefined()
  })
})

describe("projected change labels", () => {
  const projection = (status: DashboardProjection["status"], kpis: DashboardProjection["kpis"] = null): DashboardProjection => ({
    status,
    today: "2026-11-04",
    compare: { start: "2026-10-01", end: "2026-10-31" },
    basis: status === "current" ? { completeDays: 3, completeThrough: "2026-11-03" } : null,
    kpis,
    currentMonth: null,
  })
  const kpis = { totalSpend: 9, prevSpend: 136, changePercent: -93, totalTokens: 0, activeProviders: 1, topProvider: "x" }

  it("labels and tooltip", () => {
    expect(projectedChangeLabel(0.7)).toBe("+0.7% projected")
    expect(projectedChangeLabel(-12.1)).toBe("-12.1% projected")
    expect(projectedChangeLabel(null)).toBe("new")
    expect(projectionTooltip({ completeDays: 3, completeThrough: "2026-11-03" }, 8768)).toBe(
      "Projected from 3 complete days (through Nov 3); actual to date $8,768.00"
    )
    expect(projectionTooltip({ completeDays: 0, completeThrough: null }, 0)).toMatch(/^Projected from the trailing 28-day average/)
  })

  it("KPI card: projected when current, actual MoM when past, none when future", () => {
    const cur = spendChange(kpis, projection("current", { projectedSpend: 120, actualToDate: 9, compareSpend: 136, changePercent: -11.8 }))
    expect(cur).toMatchObject({ label: "-11.8% projected", trend: "down" })
    expect(cur.title).toContain("actual to date $9.00")
    expect(spendChange(kpis, projection("current", { projectedSpend: 120, actualToDate: 9, compareSpend: 0, changePercent: null })).label).toBe(
      "new (projected)"
    )
    expect(spendChange(kpis, projection("past")).label).toBe("-93% MoM")
    expect(spendChange(kpis, projection("future")).label).toBe("no data yet")
    expect(spendChange(kpis).label).toBe("-93% MoM")
  })

  it("tools table", () => {
    const tool = { id: "p", name: "P", monthlySpend: 9, usageVolume: "", change: "down" as const, changePercent: 93, changeDirection: "down" as const, subscriptionType: "", color: "" }
    expect(toolChange({ ...tool, projectedSpend: 140, projectedChangePercent: 2.9 }, projection("current"))).toMatchObject({ label: "+2.9% projected", direction: "stable" })
    expect(toolChange({ ...tool, projectedSpend: 20, projectedChangePercent: null }, projection("current")).label).toBe("new")
    expect(toolChange(tool, projection("past"))).toMatchObject({ label: "93%", direction: "down" })
    expect(toolChange(tool, projection("future")).label).toBe("—")
  })

  it("org Change column", () => {
    const p = { status: "current" as const, today: "2026-11-04", completeDays: 3, completeThrough: "2026-11-03", total: null }
    const e = { cost: 416, changePercent: -91.8, projectedCost: 5140, projectedChangePercent: 0.7 }
    expect(changeCell(e, p)).toMatchObject({ text: "+0.7% proj.", projected: true })
    expect(changeCell(e, p).title).toBe("Projected from 3 complete days (through Nov 3); actual to date $416.00; projected $5,140.00")
    expect(changeCell({ ...e, projectedChangePercent: null }, p).text).toBe("new")
    expect(changeCell({ cost: 0, changePercent: null, projectedCost: 0, projectedChangePercent: null }, p).text).toBe("–")
    expect(changeCell(e, { ...p, status: "past" })).toMatchObject({ text: "-91.8%", projected: false })
    expect(changeCell(e, { ...p, status: "future" }).text).toBe("–")
  })
})
