/**
 * @jest-environment node
 *
 * GET /api/dashboard and GET /api/dashboard/breakdown against an in-memory
 * fake of the few Supabase query-builder calls the routes make. No network,
 * no database.
 */

import { NextRequest } from "next/server"
import { FORECAST_DEFAULTS } from "@/lib/forecast-settings"
import { computeDashboard } from "@/lib/dashboard-compute"
import {
  EMPTY_ORG,
  NOV_TOTAL,
  PROVIDERS,
  attributedRows,
  plainDailyRows,
} from "@/lib/org/dashboard-fixtures"
import { D, K, PE, T, orgData } from "@/lib/org/test-fixtures"
import type { OrgData } from "@/lib/org/types"
import type { BreakdownData } from "@/lib/org/breakdown"
import type { DashboardData } from "@/lib/dashboard-types"
import type { DashboardFilters } from "@/lib/dashboard-filters"
import type { UnitForecastMeta } from "@/lib/dashboard-compute"
import { computeUnitForecasts, unitOverrideKey, type UnitOverrides } from "@/lib/unit-forecast"
import { monthRange, projectPeriod, projectionContext } from "@/lib/projection"

jest.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }) }))
const mockOverrides: { value: UnitOverrides } = { value: {} }
jest.mock("@/lib/forecast-settings", () => {
  const actual = jest.requireActual("@/lib/forecast-settings")
  return {
    ...actual,
    getForecastSettings: async () => actual.FORECAST_DEFAULTS,
    getForecastUnitOverrides: async () => mockOverrides.value,
  }
})

type Row = Record<string, unknown>
let tables: Record<string, Row[]> = {}
const reads: string[] = []
let authed = true

interface FakeQuery {
  select(): FakeQuery
  order(): FakeQuery
  eq(col: string, v: unknown): FakeQuery
  is(col: string, v: unknown): FakeQuery
  gte(col: string, v: unknown): FakeQuery
  lt(col: string, v: unknown): FakeQuery
  range(a: number, b: number): FakeQuery
  then(resolve: (v: unknown) => void): void
}

/** Thenable query builder supporting select/order/range/eq/is/gte/lt (gte/lt compare as strings, fine for ISO timestamps). */
function fakeFrom(table: string): FakeQuery {
  reads.push(table)
  let rows = [...(tables[table] ?? [])]
  let range: [number, number] | null = null
  const q: FakeQuery = {
    select: () => q,
    order: () => q,
    eq: (col, v) => ((rows = rows.filter((r) => r[col] === v)), q),
    is: (col, v) => ((rows = rows.filter((r) => (r[col] ?? null) === v)), q),
    gte: (col, v) => ((rows = rows.filter((r) => String(r[col]) >= String(v))), q),
    lt: (col, v) => ((rows = rows.filter((r) => String(r[col]) < String(v))), q),
    range: (a, b) => ((range = [a, b]), q),
    then: (resolve) =>
      resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null }),
  }
  return q
}

jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db")
  return {
    ...actual,
    createClient: async () => ({ from: fakeFrom }),
    requireAuth: async () => {
      if (!authed) throw new Error("Unauthorized")
      return "user-1"
    },
  }
})

// Imported after the mocks.
import { GET as getDashboard } from "./route"
import { GET as getBreakdown } from "./breakdown/route"

function seed(org: OrgData) {
  tables = {
    providers: PROVIDERS as unknown as Row[],
    cost_records_daily: plainDailyRows(),
    cost_records_daily_attributed: attributedRows(org) as unknown as Row[],
    departments: org.departments as unknown as Row[],
    teams: org.teams as unknown as Row[],
    people: org.people as unknown as Row[],
    org_api_keys: org.apiKeys as unknown as Row[],
  }
  reads.length = 0
}

const req = (path: string) => new NextRequest(new URL(path, "http://localhost"))
type DashboardBody = DashboardData & {
  filters: DashboardFilters
  forecastMeta: { employees: number; plateau: number; unit?: UnitForecastMeta; trailingAverage?: number }
}
const json = async <T,>(res: Response) => ({ status: res.status, body: (await res.json()) as T })
const dash = async (path: string) => json<DashboardBody>(await getDashboard(req(path)))
const brk = async (path: string) => json<BreakdownData>(await getBreakdown(req(path)))

// Issue #39: the forecast projects the clock's current month, so pin the
// clock: Nov 3, 2026, with the fixture's Nov 1-2 complete.
const NOW = new Date("2026-11-03T12:00:00Z")
beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["setTimeout", "clearTimeout", "setImmediate", "nextTick", "queueMicrotask"] })
})
afterAll(() => {
  jest.useRealTimers()
})

beforeEach(() => {
  authed = true
  mockOverrides.value = {}
  seed(orgData())
})

const projected = (body: DashboardBody) =>
  body.forecast.filter((f) => f.projected).map(({ month, total }) => ({ month, total }))

describe("GET /api/dashboard", () => {
  it("without filters reads cost_records_daily and returns the pinned response", async () => {
    const { status, body } = await dash("/api/dashboard?month=2026-11")
    expect(status).toBe(200)
    expect(reads).toContain("cost_records_daily")
    expect(reads).not.toContain("cost_records_daily_attributed")

    // Regression: the existing response fields, pinned from fixture data.
    expect(body.months).toEqual(["2026-11", "2026-10"])
    expect(body.selectedMonth).toBe("2026-11")
    expect(body.dataStart).toBe("2026-10-01")
    expect(body.dataEnd).toBe("2026-11-02")
    expect(body.period).toEqual({ start: "2026-11-01", end: "2026-11-30", mode: "month" })
    // KPIs compare with the preceding equal-length window (Oct 2-31 for a
    // 30-day November), so the Oct 1 Windsurf row is excluded: unchanged
    // pre-#8 behavior.
    expect(body.kpis).toEqual({
      totalSpend: 250,
      prevSpend: 85,
      changePercent: 194,
      totalTokens: 7000,
      activeProviders: 4,
      topProvider: "Anthropic (Claude API)",
    })
    expect(body.tools.map((t) => [t.name, t.monthlySpend, t.changeDirection, t.changePercent, t.color])).toEqual([
      ["Anthropic (Claude API)", 150, "up", 173, "#24AE1D"],
      ["OpenAI API", 50, "stable", 0, "#C068F9"],
      ["Cursor (Admin API)", 30, "stable", 0, "#00C1DB"],
      ["Windsurf (CascadeAnalytics)", 20, "stable", 0, "#F77F00"],
    ])
    expect(body.trends).toEqual([
      { month: "2026-10", total: 105, anthropic: 55, cursor: 30, windsurf: 20 },
      { month: "2026-11", total: 250, anthropic: 150, openai: 50, cursor: 30, windsurf: 20 },
    ])
    expect(body.byModel[0]).toEqual({ model: "claude-opus", total: 110, color: "#24AE1D" })
    // Issue #39: the partial November is a projected point, then December.
    expect(body.forecast.filter((f) => f.projected).map((f) => f.month)).toEqual(["2026-11", "2026-12"])
    expect(body.forecast.find((f) => f.month === "2026-11")).toMatchObject({ projected: true, actualToDate: 250 })
    expect(body.forecastMeta.employees).toBe(FORECAST_DEFAULTS.employees)
  })

  it("is identical whether computed from cost_records_daily or the attributed view with no org", () => {
    const params = { month: "2026-11" }
    const now = new Date("2026-11-15T00:00:00Z")
    const base = { providers: PROVIDERS, params, forecastSettings: FORECAST_DEFAULTS, now }
    const plain = computeDashboard({ ...base, daily: plainDailyRows() })
    expect(computeDashboard({ ...base, daily: attributedRows(EMPTY_ORG) })).toEqual(plain)
    expect(computeDashboard({ ...base, daily: attributedRows(orgData()) })).toEqual(plain)
  })

  it("team filter narrows KPIs, tools and trend", async () => {
    const { body } = await dash(`/api/dashboard?month=2026-11&team=${T.data}`)
    expect(reads).toContain("cost_records_daily_attributed")
    expect(body.filters).toEqual({ team: T.data })
    expect(body.kpis.totalSpend).toBe(70)
    expect(body.tools.map((t) => [t.name, t.monthlySpend])).toEqual([
      ["OpenAI API", 40],
      ["Cursor (Admin API)", 30],
    ])
    expect(body.trends.find((t) => t.month === "2026-11")?.total).toBe(70)
  })

  const ctx = () => projectionContext(PROVIDERS, NOW)
  const projectedNov = (rows: ReturnType<typeof attributedRows>) => projectPeriod(rows, monthRange("2026-11"), ctx())!.projected

  it("team filter returns that team's forecast series", async () => {
    const { body } = await dash(`/api/dashboard?month=2026-11&team=${T.data}`)
    const all = attributedRows(orgData())
    const expected = computeUnitForecasts({ rows: all, level: "team", settings: FORECAST_DEFAULTS, current: ctx() })
      .units.find((u) => u.key === T.data)!
    // Data: $100 of the org's $355 over Sep-Nov, anchored on its projected
    // November (issue #39; $70 actual on Nov 1-2).
    const plateau = (58000 * 100) / 355
    const nov = projectedNov(all.filter((r) => r.team_id === T.data))
    expect(nov).toBeGreaterThan(70)
    expect(projected(body)).toEqual([
      { month: "2026-11", total: nov },
      { month: "2026-12", total: Math.round((nov + (plateau - nov) * 0.45) * 100) / 100 },
    ])
    expect(projected(body).slice(1)).toEqual(expected.projection)
    expect(body.forecast.find((f) => f.month === "2026-11")?.actualToDate).toBe(70)
    expect(body.forecast.filter((f) => !f.projected)).toEqual([{ month: "2026-10", total: 30, projected: false }])
    expect(body.forecastMeta.unit).toMatchObject({ level: "team", key: T.data, override: null, trailingSpend: 100 })
    expect(body.forecastMeta.unit!.plateau).toBeCloseTo(plateau, 2)
    // The org plateau is still reported for context.
    expect(body.forecastMeta.plateau).toBe(58000)
  })

  it("team forecasts across all teams plus Unassigned sum to the org forecast", async () => {
    const org = (await dash("/api/dashboard?month=2026-11")).body
    let sum = 0
    for (const team of [T.platform, T.data, T.field, T.orphan, "unassigned"]) {
      sum += projected((await dash(`/api/dashboard?month=2026-11&team=${team}`)).body).find((p) => p.month === "2026-12")!.total
    }
    expect(projected(org)[1].month).toBe("2026-12")
    expect(Math.abs(sum - projected(org)[1].total)).toBeLessThanOrEqual(1)
  })

  it("department filter returns that department's forecast", async () => {
    const { body } = await dash(`/api/dashboard?month=2026-11&department=${D.eng}`)
    const expected = computeUnitForecasts({ rows: attributedRows(orgData()), level: "department", settings: FORECAST_DEFAULTS, current: ctx() })
      .units.find((u) => u.key === D.eng)!
    expect(projected(body).slice(1)).toEqual(expected.projection)
    expect(projected(body)[0]).toEqual({ month: "2026-11", total: expected.anchor })
    expect(body.forecastMeta.unit).toMatchObject({ level: "department", key: D.eng })
  })

  it("a team override changes only that team's forecast", async () => {
    const before = projected((await dash(`/api/dashboard?month=2026-11&team=${T.platform}`)).body)
    mockOverrides.value = { [unitOverrideKey("team", T.data)]: { plateauUsd: 1000 } }
    const data = await dash(`/api/dashboard?month=2026-11&team=${T.data}`)
    const nov = projectedNov(attributedRows(orgData()).filter((r) => r.team_id === T.data))
    expect(projected(data.body)).toEqual([
      { month: "2026-11", total: nov },
      { month: "2026-12", total: Math.round((nov + (1000 - nov) * 0.45) * 100) / 100 },
    ])
    expect(data.body.forecastMeta.unit).toMatchObject({ override: "plateau", plateau: 1000 })
    expect(projected((await dash(`/api/dashboard?month=2026-11&team=${T.platform}`)).body)).toEqual(before)
    // The unfiltered org forecast ignores unit overrides.
    const orgNov = projectedNov(attributedRows(orgData()))
    expect(projected((await dash("/api/dashboard?month=2026-11")).body)).toEqual([
      { month: "2026-11", total: orgNov },
      { month: "2026-12", total: Math.round((orgNov + (58000 - orgNov) * 0.45) * 100) / 100 },
    ])
  })

  it("a team outside the filtered department gets no projection", async () => {
    const { body } = await dash(`/api/dashboard?month=2026-11&department=${D.sales}&team=${T.data}`)
    expect(body.forecast.some((f) => f.projected)).toBe(false)
    expect(body.forecastMeta.unit).toBeUndefined()
  })

  it("person filter shows the projected current month and a trailing average of complete months", async () => {
    const { body } = await dash(`/api/dashboard?month=2026-11&person=${PE.alice}`)
    const aliceAll = attributedRows(orgData()).filter((r) => r.person_id === PE.alice)
    // Only the current month is projected; no saturating forecast beyond it.
    const nov = projectPeriod(aliceAll, monthRange("2026-11"), ctx())!
    expect(projected(body)).toEqual([{ month: "2026-11", total: nov.projected }])
    expect(body.projection?.currentMonth).toMatchObject({ month: "2026-11", projected: nov.projected, actualToDate: 140, prevMonth: "2026-10", prevTotal: 50 })
    // Aug-Oct spend over 3 months: the partial November is excluded (issue #39).
    const alice = aliceAll.filter((r) => r.date >= "2026-08-01" && r.date < "2026-11-01")
    const sum = alice.reduce((acc, r) => acc + Number(r.total_cost_usd), 0)
    expect(sum).toBe(50)
    expect(body.forecastMeta.trailingAverage).toBe(Math.round((sum / 3) * 100) / 100)
  })

  it("with no org structure, the unfiltered forecast is unchanged and a team filter is all Unassigned", async () => {
    seed(EMPTY_ORG)
    const org = (await dash("/api/dashboard?month=2026-11")).body
    const nov = projectPeriod(attributedRows(EMPTY_ORG), monthRange("2026-11"), ctx())!.projected
    expect(org.forecast).toEqual([
      { month: "2026-10", total: 105, projected: false },
      { month: "2026-11", total: nov, projected: true, actualToDate: 250 },
      { month: "2026-12", total: Math.round((nov + (58000 - nov) * 0.45) * 100) / 100, projected: true },
    ])
    expect(org.forecastMeta).toEqual({ employees: 160, plateau: 58000, perPersonPct: 0.02, baselineEmployees: 160 })
    const un = (await dash("/api/dashboard?month=2026-11&team=unassigned")).body
    expect(un.forecast).toEqual(org.forecast)
  })

  it("person filter returns only that person's spend", async () => {
    const { body } = await dash(`/api/dashboard?month=2026-11&person=${PE.bob}`)
    expect(body.kpis.totalSpend).toBe(50)
    expect(body.tools).toHaveLength(1)
  })

  it("provider filter works without org structure", async () => {
    seed(EMPTY_ORG)
    const { body } = await dash("/api/dashboard?month=2026-11&provider=windsurf")
    expect(body.kpis.totalSpend).toBe(20)
  })

  it("returns 401 when not signed in", async () => {
    authed = false
    expect((await getDashboard(req("/api/dashboard"))).status).toBe(401)
  })
})

describe("GET /api/dashboard/breakdown", () => {
  it("returns every level reconciling to the org total", async () => {
    const { status, body } = await brk("/api/dashboard/breakdown?month=2026-11")
    expect(status).toBe(200)
    expect(body.orgConfigured).toBe(true)
    for (const level of ["department", "team", "person", "api_key"] as const) {
      const s = body[level].reduce((a: number, e: { cost: number }) => a + e.cost, 0)
      expect(Math.round(s * 100) / 100).toBe(NOV_TOTAL)
    }
    expect(body.department.find((e) => e.key === D.eng)).toMatchObject({ cost: 170, changePercent: 112.5 })
  })

  it("team filter excludes other teams; key list is scoped", async () => {
    const { body } = await brk(`/api/dashboard/breakdown?month=2026-11&team=${T.data}`)
    expect(body.total.cost).toBe(70)
    expect(body.level).toBe("person")
    expect(body.api_key.filter((k) => !k.unassigned).map((k) => k.key)).toEqual([K.team])
  })

  it("with no org structure, everything is Unassigned", async () => {
    seed(EMPTY_ORG)
    const { body } = await brk("/api/dashboard/breakdown?month=2026-11")
    expect(body.orgConfigured).toBe(false)
    expect(body.department).toEqual([expect.objectContaining({ unassigned: true, cost: NOV_TOTAL })])
  })

  it("returns 401 when not signed in", async () => {
    authed = false
    expect((await getBreakdown(req("/api/dashboard/breakdown"))).status).toBe(401)
  })
})
