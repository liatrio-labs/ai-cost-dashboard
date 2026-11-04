/**
 * Team / department forecasts (issue #9). Pure functions, fixture rows only.
 */

import { FORECAST_DEFAULTS, plateauForEmployees, type ForecastSettings } from "@/lib/forecast-settings"
import { computeDashboard } from "@/lib/dashboard-compute"
import { forecastDescription } from "@/lib/dashboard-types"
import { EMPTY_ORG, PROVIDERS, attributedRows, plainDailyRows } from "@/lib/org/dashboard-fixtures"
import { D, T, orgData } from "@/lib/org/test-fixtures"
import { UNASSIGNED_KEY } from "@/lib/org/rollup"
import { monthRange, projectPeriod, projectionContext } from "@/lib/projection"
import {
  coerceUnitOverrides,
  computeUnitForecasts,
  forecastUnitForFilters,
  orgProjection,
  serializeUnitOverrides,
  trailingAverage,
  trailingWindow,
  unitOverrideKey,
  type MonthTotal,
  type UnitForecastResult,
  type UnitLevel,
  type UnitRow,
} from "./unit-forecast"

const S = FORECAST_DEFAULTS
const ORG_PLATEAU = plateauForEmployees(S)

/** The org projection as /api/dashboard computed it before #9, kept verbatim as a golden. */
function legacyProjection(history: MonthTotal[], ceiling: number): MonthTotal[] {
  const out: MonthTotal[] = []
  if (history.length < 1) return out
  const lastMonth = history[history.length - 1].month
  const anchor =
    history.length >= 2
      ? Math.max(history[history.length - 1].total, history[history.length - 2].total)
      : history[history.length - 1].total
  const endOfYear = `${lastMonth.slice(0, 4)}-12`
  let cursor = lastMonth
  let value = anchor
  for (let i = 0; i < 12 && cursor < endOfYear; i++) {
    const [y, mo] = cursor.split("-").map(Number)
    const d = new Date(Date.UTC(y, mo, 1))
    cursor = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
    value = value + (ceiling - value) * 0.45
    out.push({ month: cursor, total: Math.round(value * 100) / 100 })
  }
  return out
}

/** Deterministic pseudo-random rows over Jan..Jul 2026 across teams, depts and Unassigned. */
function syntheticRows(): UnitRow[] {
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const units: [string | null, string | null][] = [
    [T.platform, D.eng],
    [T.data, D.eng],
    [T.field, D.sales],
    [T.orphan, null],
    [null, null],
  ]
  const rows: UnitRow[] = []
  for (let m = 1; m <= 7; m++) {
    for (const [team_id, department_id] of units) {
      for (let day = 1; day <= 3; day++) {
        rows.push({
          date: `2026-0${m}-0${day}`,
          team_id,
          department_id,
          total_cost_usd: Math.round(rnd() * 500000 * m) / 1e4,
        })
      }
    }
  }
  return rows
}

function sumByMonth(result: UnitForecastResult): Map<string, number> {
  const out = new Map<string, number>()
  for (const u of result.units) for (const p of u.projection) out.set(p.month, (out.get(p.month) || 0) + p.total)
  return out
}

const datasets: [string, UnitRow[]][] = [
  ["dashboard fixture", attributedRows(orgData())],
  ["synthetic Jan-Jul", syntheticRows()],
]

describe("orgProjection", () => {
  it.each(datasets)("matches the pre-#9 algorithm (%s)", (_name, rows) => {
    const { orgHistory } = computeUnitForecasts({ rows, level: "team", settings: S })
    expect(orgProjection(orgHistory, ORG_PLATEAU)).toEqual(legacyProjection(orgHistory, ORG_PLATEAU))
  })

  it("pins the fixture's December value", () => {
    // Oct 105, Nov 250 -> anchor 250; 250 + (58000 - 250) * 0.45
    expect(orgProjection([{ month: "2026-10", total: 105 }, { month: "2026-11", total: 250 }], 58000)).toEqual([
      { month: "2026-12", total: 26237.5 },
    ])
  })
})

describe("computeUnitForecasts", () => {
  describe.each(datasets)("%s", (_name, rows) => {
    it.each<UnitLevel>(["team", "department"])("%s forecasts sum to the org forecast per future month (+/- $1)", (level) => {
      const result = computeUnitForecasts({ rows, level, settings: S })
      expect(result.orgProjection.length).toBeGreaterThan(0)
      const sums = sumByMonth(result)
      for (const p of result.orgProjection) {
        expect(Math.abs((sums.get(p.month) ?? 0) - p.total)).toBeLessThanOrEqual(1)
      }
      // Shares and allocated plateaus also reconcile.
      expect(result.units.reduce((a, u) => a + u.share, 0)).toBeCloseTo(1, 9)
      expect(Math.abs(result.units.reduce((a, u) => a + u.allocatedPlateau, 0) - ORG_PLATEAU)).toBeLessThanOrEqual(1)
    })

    it("always has an Unassigned unit", () => {
      for (const level of ["team", "department"] as const) {
        expect(computeUnitForecasts({ rows, level, settings: S }).units.some((u) => u.key === UNASSIGNED_KEY)).toBe(true)
      }
    })
  })

  it("uses the trailing 3 calendar months ending at the last data month", () => {
    const result = computeUnitForecasts({ rows: syntheticRows(), level: "team", settings: S })
    expect(result.trailingMonths).toEqual(["2026-05", "2026-06", "2026-07"])
    expect(trailingWindow("2026-02")).toEqual(["2025-12", "2026-01", "2026-02"])
  })

  it("a unit with zero trailing spend projects $0", () => {
    // Orphan has no rows at all; "old" only spent outside the trailing window.
    const rows: UnitRow[] = [
      ...syntheticRows().filter((r) => r.team_id !== T.orphan),
      { date: "2026-01-15", team_id: "team-old", department_id: D.eng, total_cost_usd: 900 },
    ]
    const result = computeUnitForecasts({ rows, level: "team", settings: S, include: [T.orphan] })
    for (const key of [T.orphan, "team-old"]) {
      const u = result.units.find((x) => x.key === key)!
      expect(u.share).toBe(0)
      expect(u.plateau).toBe(0)
      expect(u.projection.length).toBeGreaterThan(0)
      expect(u.projection.every((p) => p.total === 0)).toBe(true)
    }
  })

  it("a zero-spend unit with an override ramps toward the override plateau", () => {
    const overrides = { [unitOverrideKey("team", T.orphan)]: { plateauUsd: 1000 } }
    const rows = syntheticRows().filter((r) => r.team_id !== T.orphan)
    const u = computeUnitForecasts({ rows, level: "team", settings: S, overrides, include: [T.orphan] }).units.find(
      (x) => x.key === T.orphan
    )!
    expect(u.override).toBe("plateau")
    expect(u.projection[0].total).toBe(450) // 0 + (1000 - 0) * 0.45
  })

  it.each([
    ["plateau", { plateauUsd: 12345 }, 12345],
    ["headcount", { headcount: 16 }, (16 * ORG_PLATEAU) / S.employees],
  ] as const)("a %s override changes only that unit", (kind, override, expectedPlateau) => {
    const rows = syntheticRows()
    const base = computeUnitForecasts({ rows, level: "team", settings: S })
    const withOverride = computeUnitForecasts({
      rows,
      level: "team",
      settings: S,
      overrides: { [unitOverrideKey("team", T.data)]: override },
    })
    for (const u of withOverride.units) {
      const before = base.units.find((b) => b.key === u.key)!
      if (u.key === T.data) {
        expect(u.override).toBe(kind)
        expect(u.plateau).toBeCloseTo(expectedPlateau, 2)
        expect(u.allocatedPlateau).toBe(before.allocatedPlateau)
        expect(u.projection).not.toEqual(before.projection)
      } else {
        expect(u).toEqual(before)
      }
    }
    expect(withOverride.orgProjection).toEqual(base.orgProjection)
  })

  it("a team override does not affect department forecasts", () => {
    const rows = syntheticRows()
    const overrides = { [unitOverrideKey("team", T.data)]: { plateauUsd: 1 } }
    expect(computeUnitForecasts({ rows, level: "department", settings: S, overrides })).toEqual(
      computeUnitForecasts({ rows, level: "department", settings: S })
    )
  })

  it("with no org structure, Unassigned is the whole org and matches the org forecast", () => {
    const result = computeUnitForecasts({ rows: attributedRows(EMPTY_ORG), level: "team", settings: S })
    expect(result.units).toHaveLength(1)
    expect(result.units[0]).toMatchObject({ key: UNASSIGNED_KEY, share: 1 })
    expect(result.units[0].projection).toEqual(result.orgProjection)
  })

  it("with no trailing org spend, Unassigned carries the org plateau", () => {
    const rows: UnitRow[] = [{ date: "2026-05-01", team_id: T.data, department_id: D.eng, total_cost_usd: 0 }]
    const result = computeUnitForecasts({ rows, level: "team", settings: S })
    expect(result.units.find((u) => u.key === UNASSIGNED_KEY)!.plateau).toBe(Math.round(ORG_PLATEAU * 100) / 100)
    expect(result.units.find((u) => u.key === T.data)!.plateau).toBe(0)
  })

  it("returns no projection with no history", () => {
    const result = computeUnitForecasts({ rows: [], level: "team", settings: S })
    expect(result.orgProjection).toEqual([])
    expect(result.units.every((u) => u.projection.length === 0)).toBe(true)
  })

  it("scales with the org settings", () => {
    const bigger: ForecastSettings = { ...S, employees: S.employees + 50 }
    const a = computeUnitForecasts({ rows: syntheticRows(), level: "team", settings: S })
    const b = computeUnitForecasts({ rows: syntheticRows(), level: "team", settings: bigger })
    expect(b.orgPlateau).toBeGreaterThan(a.orgPlateau)
  })
})

describe("computeDashboard regression", () => {
  it("org forecast is unchanged with no org structure", () => {
    const base = { providers: PROVIDERS, params: { month: "2026-11" }, forecastSettings: S, now: new Date("2026-11-15T00:00:00Z") }
    const plain = computeDashboard({ ...base, daily: plainDailyRows() })
    // Issue #39: the partial November is projected and anchors December.
    const nov = projectPeriod(plainDailyRows(), monthRange("2026-11"), projectionContext(PROVIDERS, base.now))!.projected
    expect(nov).toBeGreaterThan(250)
    expect(plain.forecast).toEqual([
      { month: "2026-10", total: 105, projected: false },
      { month: "2026-11", total: nov, projected: true, actualToDate: 250 },
      { month: "2026-12", total: Math.round((nov + (ORG_PLATEAU - nov) * 0.45) * 100) / 100, projected: true },
    ])
    expect(plain.forecastMeta).toEqual({ employees: 160, plateau: 58000, perPersonPct: 0.02, baselineEmployees: 160 })
    expect(computeDashboard({ ...base, daily: attributedRows(EMPTY_ORG) })).toEqual(plain)
  })

  it("a unit forecast replaces the projection and adds forecastMeta.unit", () => {
    const rows = attributedRows(orgData())
    const now = new Date("2026-11-15T00:00:00Z")
    const current = projectionContext(PROVIDERS, now)
    const unit = computeUnitForecasts({ rows, level: "team", settings: S, current }).units.find((u) => u.key === T.data)!
    const out = computeDashboard({
      daily: rows.filter((r) => r.team_id === T.data),
      providers: PROVIDERS,
      params: { month: "2026-11" },
      forecastSettings: S,
      now,
      projectForecast: false,
      unitForecast: unit,
    })
    // The projected current month (the unit's anchor), then the unit's projection.
    expect(out.forecast.filter((f) => f.projected).map(({ month, total }) => ({ month, total }))).toEqual([
      { month: "2026-11", total: unit.anchor },
      ...unit.projection,
    ])
    expect(out.forecastMeta).toMatchObject({ plateau: 58000, unit: { level: "team", key: T.data, override: null } })
  })
})

describe("helpers", () => {
  it("forecastUnitForFilters picks the most specific unit, and none for person/key/provider", () => {
    expect(forecastUnitForFilters({})).toBeNull()
    expect(forecastUnitForFilters({ department: D.eng })).toEqual({ level: "department", key: D.eng })
    expect(forecastUnitForFilters({ department: D.eng, team: T.data })).toEqual({ level: "team", key: T.data })
    expect(forecastUnitForFilters({ team: "unassigned" })).toEqual({ level: "team", key: "unassigned" })
    expect(forecastUnitForFilters({ team: T.data, person: "p" })).toBeNull()
    expect(forecastUnitForFilters({ team: T.data, key: "k" })).toBeNull()
    expect(forecastUnitForFilters({ department: D.eng, provider: "openai" })).toBeNull()
  })

  it("trailingAverage counts missing months as $0", () => {
    const rows = [
      { date: "2026-11-02", total_cost_usd: 90 },
      { date: "2026-09-10", total_cost_usd: "30" },
      { date: "2026-08-10", total_cost_usd: 1000 }, // outside the window
    ]
    expect(trailingAverage(rows, "2026-11")).toBe(40)
  })

  it("override coercion round-trips and drops junk", () => {
    const stored = {
      overrides: {
        "team:t1": { plateau_usd: 100, headcount: null },
        "department:unassigned": { plateau_usd: null, headcount: "4" },
        "team:t2": { plateau_usd: -5, headcount: null }, // negative -> dropped
        "person:p1": { plateau_usd: 10 }, // not a unit level
        "team:": { plateau_usd: 10 },
      },
    }
    const o = coerceUnitOverrides(stored)
    expect(o).toEqual({
      "team:t1": { plateauUsd: 100, headcount: null },
      "department:unassigned": { plateauUsd: null, headcount: 4 },
    })
    expect(coerceUnitOverrides(serializeUnitOverrides(o))).toEqual(o)
    expect(coerceUnitOverrides(null)).toEqual({})
  })
})

describe("forecastDescription", () => {
  const meta = { employees: 160, plateau: 58000, perPersonPct: 0.02, baselineEmployees: 160 }
  it("describes org, unit, override and trailing-average views", () => {
    expect(forecastDescription(meta)).toBe("History (solid) with trend projection (dashed)")
    const unit = { level: "team" as const, key: T.data, unassigned: false, share: 0.25, trailingSpend: 100, allocatedPlateau: 14500, plateau: 14500, override: null }
    expect(forecastDescription({ ...meta, unit }, "Data")).toBe("Data: plateau $14,500.00/mo (25.0% of trailing 3-month org spend)")
    expect(forecastDescription({ ...meta, unit: { ...unit, override: "plateau", plateau: 1000 } }, "Data")).toBe(
      "Data: plateau $1,000.00/mo (admin plateau override)"
    )
    expect(forecastDescription({ ...meta, trailingAverage: 40 }, undefined, false)).toBe(
      "No forecast for this view; trailing 3-month average $40.00/mo"
    )
    expect(forecastDescription(meta, undefined, false)).toBe("History only for this view")
  })
})

describe("unit forecast chart series", () => {
  it("fills months a unit has no spend in with $0 up to the org's last month", () => {
    // Org has Sep-Nov; the team only spent in Sep.
    const rows: UnitRow[] = [
      { date: "2026-09-05", team_id: T.data, department_id: D.eng, total_cost_usd: 30 },
      { date: "2026-09-05", team_id: T.platform, department_id: D.eng, total_cost_usd: 70 },
      { date: "2026-10-05", team_id: T.platform, department_id: D.eng, total_cost_usd: 80 },
      { date: "2026-11-01", team_id: T.platform, department_id: D.eng, total_cost_usd: 90 },
    ]
    const now = new Date("2026-11-15T00:00:00Z")
    const unit = computeUnitForecasts({ rows, level: "team", settings: S, current: projectionContext(PROVIDERS, now) }).units.find(
      (u) => u.key === T.data
    )!
    const out = computeDashboard({
      daily: rows.filter((r) => r.team_id === T.data).map((r) => ({ ...r, provider_id: "p", model_name: "m" })),
      providers: PROVIDERS,
      params: { month: "2026-11" },
      forecastSettings: S,
      now,
      projectForecast: false,
      unitForecast: unit,
    })
    // Complete months are actuals (Oct filled with $0); the current month is projected (issue #39).
    expect(out.forecast.map((f) => [f.month, f.projected])).toEqual([
      ["2026-09", false],
      ["2026-10", false],
      ["2026-11", true],
      ["2026-12", true],
    ])
    expect(out.forecast.slice(1, 3).map((f) => f.total)).toEqual([0, 0])
  })
})
