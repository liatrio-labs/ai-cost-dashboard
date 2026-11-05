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
import { D, K, P, PE, T, orgData } from "@/lib/org/test-fixtures"
import type { OrgData } from "@/lib/org/types"
import type { BreakdownData } from "@/lib/org/breakdown"
import type { DashboardData } from "@/lib/dashboard-types"
import type { DashboardFilters } from "@/lib/dashboard-filters"
import type { UnitForecastMeta } from "@/lib/dashboard-compute"
import { computeUnitForecasts, unitOverrideKey, type UnitOverrides } from "@/lib/unit-forecast"
import { monthRange, projectPeriod, projectionContext } from "@/lib/projection"
import {
  CLAUDE_AI,
  NOV_ALICE,
  NOV_CLAUDE_AI,
  PROVIDERS_WITH_CLAUDE_AI,
  claudeAiAttributedRows,
  claudeAiPlainDailyRows,
  claudeAiProductCostRows,
} from "@/lib/claude-ai-product-fixtures"

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
/** Tables whose reads fail (issue #48: the product split is optional). */
const failing = new Set<string>()
/** Tables whose reads return this PostgREST error (issue #59: 022 not applied). */
const tableErrors: Record<string, { code: string; message: string }> = {}

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

/** Compare like Postgres would: timestamps as instants, anything else as strings. */
function cmp(a: unknown, b: unknown): number {
  const x = Date.parse(String(a))
  const y = Date.parse(String(b))
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y
  return String(a).localeCompare(String(b))
}

/** Thenable query builder supporting select/order/range/eq/is/gte/lt. */
function fakeFrom(table: string): FakeQuery {
  reads.push(table)
  let rows = [...(tables[table] ?? [])]
  let range: [number, number] | null = null
  const q: FakeQuery = {
    select: () => q,
    order: () => q,
    eq: (col, v) => ((rows = rows.filter((r) => r[col] === v)), q),
    is: (col, v) => ((rows = rows.filter((r) => (r[col] ?? null) === v)), q),
    gte: (col, v) => ((rows = rows.filter((r) => cmp(r[col], v) >= 0)), q),
    lt: (col, v) => ((rows = rows.filter((r) => cmp(r[col], v) < 0)), q),
    range: (a, b) => ((range = [a, b]), q),
    then: (resolve) =>
      tableErrors[table]
        ? resolve({ data: null, error: tableErrors[table] })
        : failing.has(table)
        ? resolve({ data: null, error: { message: `${table} unavailable` } })
        : resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null }),
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
  failing.clear()
  for (const k of Object.keys(tableErrors)) delete tableErrors[k]
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

describe("Claude.ai by product (issue #48)", () => {
  function seedClaudeAi(org: OrgData = orgData()) {
    seed(org)
    tables.providers = PROVIDERS_WITH_CLAUDE_AI as unknown as Row[]
    tables.cost_records_daily = [...plainDailyRows(), ...claudeAiPlainDailyRows()]
    tables.cost_records_daily_attributed = [...attributedRows(org), ...claudeAiAttributedRows(org)] as unknown as Row[]
    tables.cost_records = claudeAiProductCostRows() as unknown as Row[]
    tables.person_identities = org.identities as unknown as Row[]
  }
  const split = (products: { product: string; cost: number }[] | undefined) =>
    Object.fromEntries((products ?? []).map((p) => [p.product, p.cost]))
  const sumCents = (products: { cost: number }[]) => products.reduce((a, p) => a + Math.round(p.cost * 100), 0)

  beforeEach(() => seedClaudeAi())

  it("splits the Claude.ai tool by product on the dashboard, summing to its spend", async () => {
    const { status, body } = await dash("/api/dashboard?month=2026-11")
    expect(status).toBe(200)
    expect(reads).toContain("cost_records")
    const tool = body.tools.find((t) => t.id === CLAUDE_AI)!
    expect(tool.monthlySpend).toBe(NOV_CLAUDE_AI.total)
    expect(sumCents(tool.products!)).toBe(Math.round(tool.monthlySpend * 100))
    expect(split(tool.products)).toEqual({ claude_code: 170, chat: 70.25, other: 4.75 })
    expect(body.kpis.totalSpend).toBe(NOV_TOTAL + NOV_CLAUDE_AI.total)
  })

  it("splits a person-filtered dashboard by that person's products", async () => {
    const { body } = await dash(`/api/dashboard?month=2026-11&person=${PE.alice}`)
    const tool = body.tools.find((t) => t.id === CLAUDE_AI)!
    expect(tool.monthlySpend).toBe(NOV_ALICE.total)
    expect(split(tool.products)).toEqual({ claude_code: 120, chat: 40, other: 0 })
  })

  it("shows the person view's Claude.ai products in the breakdown", async () => {
    const { status, body } = await brk(`/api/dashboard/breakdown?month=2026-11&person=${PE.alice}`)
    expect(status).toBe(200)
    expect(body.level).toBe("detail")
    expect(reads).toEqual(expect.arrayContaining(["cost_records", "person_identities"]))
    expect(body.claudeAiProducts!.total).toBe(NOV_ALICE.total)
    expect(split(body.claudeAiProducts!.products)).toEqual({ claude_code: 120, chat: 40, other: 0 })
  })

  it("doesn't read raw records outside the person view", async () => {
    const { body } = await brk("/api/dashboard/breakdown?month=2026-11")
    expect(reads).not.toContain("cost_records")
    expect(body.claudeAiProducts).toBeNull()
  })

  it("renders without the split when the raw read fails", async () => {
    failing.add("cost_records")
    const errors = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const d = await dash("/api/dashboard?month=2026-11")
      expect(d.status).toBe(200)
      const tool = d.body.tools.find((t) => t.id === CLAUDE_AI)!
      expect(tool.monthlySpend).toBe(NOV_CLAUDE_AI.total)
      expect(tool.products).toBeUndefined()
      const b = await brk(`/api/dashboard/breakdown?month=2026-11&person=${PE.alice}`)
      expect(b.status).toBe(200)
      expect(b.body.claudeAiProducts).toBeNull()
    } finally {
      errors.mockRestore()
    }
  })
})

describe("Cursor by product (issue #65)", () => {
  beforeEach(() => {
    const org = orgData()
    seed(org)
    tables.person_identities = org.identities as unknown as Row[]
  })
  const split = (products: { product: string; cost: number }[] | undefined) =>
    Object.fromEntries((products ?? []).map((p) => [p.product, p.cost]))

  it("splits the Cursor tool on the dashboard from the rollup rows, with no raw read", async () => {
    const { body } = await dash("/api/dashboard?month=2026-11")
    const tool = body.tools.find((t) => t.id === "prov-cursor")!
    expect(tool.monthlySpend).toBe(30)
    expect(split(tool.products)).toEqual({ grok_bot: 0, bugbot: 0, agent_chat: 30 })
    expect(reads).not.toContain("cost_records")
  })

  it("follows a team filter on the dashboard", async () => {
    const data = await dash(`/api/dashboard?month=2026-11&team=${T.data}`)
    expect(split(data.body.tools.find((t) => t.id === "prov-cursor")!.products)).toEqual({ grok_bot: 0, bugbot: 0, agent_chat: 30 })
    const platform = await dash(`/api/dashboard?month=2026-11&team=${T.platform}`)
    expect(platform.body.tools.find((t) => t.id === "prov-cursor")).toBeUndefined()
  })

  it("shows the person view's Cursor products in the breakdown", async () => {
    const { body } = await brk(`/api/dashboard/breakdown?month=2026-11&person=${PE.dave}`)
    expect(body.level).toBe("detail")
    expect(body.cursorProducts!.total).toBe(30)
    expect(split(body.cursorProducts!.products)).toEqual({ grok_bot: 0, bugbot: 0, agent_chat: 30 })
    const alice = await brk(`/api/dashboard/breakdown?month=2026-11&person=${PE.alice}`)
    expect(alice.body.cursorProducts).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Issue #59: recurring monthly costs
// ---------------------------------------------------------------------------
describe("recurring monthly costs (issue #59)", () => {
  const LOVABLE = "prov-lovable"
  const ULTRA = "prov-claude-max"
  const manualProviders = [
    { id: LOVABLE, name: "lovable", display_name: "Lovable", metadata: { collection_method: "manual" } },
    { id: ULTRA, name: "claude-max", display_name: "Claude Ultra", metadata: { collection_method: "manual", billing: "seat" } },
  ]
  const segment = (id: string, provider: string, start: string, end: string | null, amount: string, seats: number | null = null, price: string | null = null) => ({
    id,
    provider_id: provider,
    start_month: `${start}-01`,
    end_month: end ? `${end}-01` : null,
    monthly_cost_usd: amount,
    seats,
    price_per_seat: price,
    notes: null,
  })
  /** A manual entry as cost_records and as its cost_records_daily / attributed rollup. */
  function addManual(provider: string, month: string, cost: number, meta: Record<string, unknown> = {}, attributed: Partial<Row> = {}) {
    const id = `cr-${provider}-${month}-${(tables.cost_records ?? []).length}`
    tables.cost_records = [
      ...(tables.cost_records ?? []),
      {
        id,
        user_id: "u1",
        provider_id: provider,
        timestamp: `${month}-01T12:00:00Z`,
        model_name: meta.entry_type === "monthly_seats" ? "seats" : "manual",
        cost_usd: cost,
        request_count: 1,
        collection_method: "manual_entry",
        metadata: { entry_type: "monthly_manual", month, ...meta },
      },
    ]
    const day = { date: `${month}-01`, provider_id: provider, model_name: "manual", total_cost_usd: cost, total_tokens: 0, total_requests: 1 }
    tables.cost_records_daily = [...tables.cost_records_daily, day]
    tables.cost_records_daily_attributed = [
      ...tables.cost_records_daily_attributed,
      { ...day, person_id: null, org_api_key_id: null, team_id: null, department_id: null, project_id: null, workspace_id: null, granularity: "org", record_count: 1, ...attributed },
    ]
  }
  beforeEach(() => {
    tables.providers = [...(PROVIDERS as unknown as Row[]), ...manualProviders]
  })

  it("count every month from the start through the current month, without a manual entry", async () => {
    tables.recurring_costs = [segment("rc1", LOVABLE, "2026-10", null, "90.00")]
    const { status, body } = await dash("/api/dashboard?month=2026-11")
    expect(status).toBe(200)
    expect(body.kpis.totalSpend).toBe(NOV_TOTAL + 90)
    expect(body.trends.map((t) => [t.month, t.total, t.lovable])).toEqual([
      ["2026-10", 105 + 90, 90],
      ["2026-11", 250 + 90, 90],
    ])
    expect(body.tools.find((t) => t.name === "Lovable")?.monthlySpend).toBe(90)
    // Seat-like spend: the current month projects the recurring amount as-is.
    expect(body.forecast.find((f) => f.month === "2026-11")).toMatchObject({ actualToDate: 340 })
    expect(body.months).toEqual(["2026-11", "2026-10"]) // never into the future
  })

  it("a manual entry for a month overrides the recurring cost for that month only (no double count)", async () => {
    tables.recurring_costs = [segment("rc1", LOVABLE, "2026-10", null, "90.00")]
    addManual(LOVABLE, "2026-10", 120)
    const { body } = await dash("/api/dashboard?month=2026-11")
    expect(body.trends.map((t) => [t.month, t.lovable])).toEqual([
      ["2026-10", 120],
      ["2026-11", 90],
    ])
  })

  it("change from a month: earlier months keep the old amount (provider filter / per-tool view)", async () => {
    tables.recurring_costs = [segment("rc1", LOVABLE, "2026-09", "2026-10", "90.00"), segment("rc2", LOVABLE, "2026-11", null, "150.00")]
    const { body } = await dash("/api/dashboard?month=2026-11&provider=lovable")
    expect(body.trends.map((t) => [t.month, t.total])).toEqual([
      ["2026-09", 90],
      ["2026-10", 90],
      ["2026-11", 150],
    ])
    expect(body.kpis.totalSpend).toBe(150)
  })

  it("seat assignments from the latest manual split apply: person and team views, remainder org-level", async () => {
    // October is a manual seat split (alice 2 of 10 seats at $50); November is recurring.
    const split = { entry_type: "monthly_seats", seats: 2, price_per_seat: 50, seat_group_id: "sg1", attribution: { granularity: "person", person_email: "alice@liatrio.com" } }
    addManual(ULTRA, "2026-10", 100, split, { person_id: PE.alice, team_id: T.platform, department_id: D.eng, granularity: "person" })
    addManual(ULTRA, "2026-10", 400, { ...split, seats: 8, remainder: true, attribution: { granularity: "org" } })
    tables.recurring_costs = [segment("rc1", ULTRA, "2026-11", null, "500.00", 10, "50.00")]
    tables.person_identities = []

    const person = await dash(`/api/dashboard?month=2026-11&person=${PE.alice}&provider=claude-max`)
    expect(person.body.kpis.totalSpend).toBe(100)
    const { body } = await brk("/api/dashboard/breakdown?month=2026-11&provider=claude-max")
    expect(body.total.cost).toBe(500)
    expect(body.person.find((p) => p.id === PE.alice)?.cost).toBe(100)
    expect(body.team.find((t) => t.id === T.platform)?.cost).toBe(100)
    // Totals reconcile with the unfiltered rollup path.
    const all = await dash("/api/dashboard?month=2026-11&provider=claude-max")
    expect(all.body.kpis.totalSpend).toBe(500)
  })

  it("without migration 022 (no recurring_costs table) the response is exactly as before", async () => {
    const before = await dash("/api/dashboard?month=2026-11")
    tableErrors.recurring_costs = { code: "PGRST205", message: "Could not find the table 'public.recurring_costs' in the schema cache" }
    const after = await dash("/api/dashboard?month=2026-11")
    expect(after.status).toBe(200)
    expect(after.body).toEqual(before.body)
    const b = await brk(`/api/dashboard/breakdown?month=2026-11&team=${T.data}`)
    expect(b.status).toBe(200)
  })
})

describe("invoice actuals (issue #75)", () => {
  // October fixture: Anthropic alice $50 (Platform) + carol $5 (no team) = $55
  // API; Cursor $30; Windsurf $20 -> $105.
  const LOVABLE = "prov-lovable"
  const invoice = (provider: string, month: string, amount: string) => ({
    id: `io-${provider}-${month}`,
    provider_id: provider,
    month: `${month}-01`,
    billed_amount_usd: amount,
    credits_usd: null,
    notes: null,
    invoice_ids: [],
    entered_by: "admin@example.com",
    entered_at: "2026-11-04T00:00:00Z",
  })
  const orgLevel = { person_id: null, org_api_key_id: null, team_id: null, department_id: null, project_id: null, workspace_id: null, granularity: "org", record_count: 1 }
  /** A manual entry as cost_records plus its two rollup rows. */
  function addManual(provider: string, month: string, cost: number) {
    tables.cost_records = [
      ...(tables.cost_records ?? []),
      { id: `cr-${provider}-${month}`, user_id: "u1", provider_id: provider, timestamp: `${month}-01T12:00:00Z`, model_name: "manual", cost_usd: cost, request_count: 1, collection_method: "manual_entry", metadata: { entry_type: "monthly_manual", month } },
    ]
    const day = { date: `${month}-01`, provider_id: provider, model_name: "manual", total_cost_usd: cost, total_tokens: 0, total_requests: 1 }
    tables.cost_records_daily = [...tables.cost_records_daily, day]
    tables.cost_records_daily_attributed = [...tables.cost_records_daily_attributed, { ...day, ...orgLevel }]
  }

  it("override vs no override: the overridden provider-month equals the invoice; other months and providers are unchanged", async () => {
    const before = await dash("/api/dashboard?month=2026-10")
    expect(before.body.trends.find((t) => t.month === "2026-10")).toMatchObject({ total: 105, anthropic: 55 })

    tables.invoice_overrides = [invoice(P.anthropic, "2026-10", "110.00")]
    const { status, body } = await dash("/api/dashboard?month=2026-10")
    expect(status).toBe(200)
    expect(body.tools.find((t) => t.name === "Anthropic (Claude API)")?.monthlySpend).toBe(110)
    expect(body.trends).toEqual([
      { month: "2026-10", total: 160, anthropic: 110, cursor: 30, windsurf: 20 },
      { month: "2026-11", total: 250, anthropic: 150, openai: 50, cursor: 30, windsurf: 20 },
    ])
    expect(body.kpis.totalSpend).toBe(160)
    // November (current month, not overridden) is exactly as before.
    const nov = await dash("/api/dashboard?month=2026-11")
    expect(nov.body.kpis.totalSpend).toBe(NOV_TOTAL)
  })

  it("attribution: person / team views scale by the org-wide factor and reconcile with the org total", async () => {
    tables.invoice_overrides = [invoice(P.anthropic, "2026-10", "110.00")]
    const { body } = await brk("/api/dashboard/breakdown?month=2026-10")
    expect(body.total.cost).toBe(160)
    expect(body.person.find((p) => p.id === PE.alice)?.cost).toBe(100)
    expect(body.person.find((p) => p.id === PE.carol)?.cost).toBe(10)
    expect(body.team.find((t) => t.id === T.platform)?.cost).toBe(100)
    const teamSum = body.team.reduce((s, t) => s + t.cost, 0)
    expect(teamSum).toBeCloseTo(160, 2)
    // A pushed-down person filter gets the same scaled amount as the breakdown.
    const alice = await dash(`/api/dashboard?month=2026-10&person=${PE.alice}`)
    expect(alice.body.kpis.totalSpend).toBe(100)
    const team = await dash(`/api/dashboard?month=2026-10&team=${T.platform}`)
    expect(team.body.kpis.totalSpend).toBe(100)
    const prov = await dash("/api/dashboard?month=2026-10&provider=anthropic")
    expect(prov.body.kpis.totalSpend).toBe(110)
  })

  it("no double count: the month's recurring cost and manual entry are replaced by the invoice; other months keep them", async () => {
    tables.providers = [...(PROVIDERS as unknown as Row[]), { id: LOVABLE, name: "lovable", display_name: "Lovable", metadata: { collection_method: "manual" } }]
    tables.recurring_costs = [
      { id: "rc1", provider_id: LOVABLE, start_month: "2026-09-01", end_month: null, monthly_cost_usd: "90.00", seats: null, price_per_seat: null, notes: null },
    ]
    addManual(LOVABLE, "2026-09", 120) // September: manual entry (recurring already skipped for it)
    tables.invoice_overrides = [invoice(LOVABLE, "2026-09", "75.00"), invoice(LOVABLE, "2026-10", "60.00")]
    const { body } = await dash("/api/dashboard?month=2026-11&provider=lovable")
    expect(body.trends.map((t) => [t.month, t.total])).toEqual([
      ["2026-09", 75],
      ["2026-10", 60],
      ["2026-11", 90],
    ])
    const all = await dash("/api/dashboard?month=2026-10")
    expect(all.body.trends.find((t) => t.month === "2026-10")).toMatchObject({ total: 105 + 60, lovable: 60 })
    const b = await brk("/api/dashboard/breakdown?month=2026-09")
    expect(b.body.total.cost).toBe(75)
  })

  it("missing-table fallback: without migration 024 the responses are exactly as without overrides", async () => {
    const before = await dash("/api/dashboard?month=2026-10")
    const beforeBrk = await brk("/api/dashboard/breakdown?month=2026-10")
    tables.invoice_overrides = [invoice(P.anthropic, "2026-10", "110.00")]
    tableErrors.invoice_overrides = { code: "PGRST205", message: "Could not find the table 'public.invoice_overrides' in the schema cache" }
    const after = await dash("/api/dashboard?month=2026-10")
    expect(after.status).toBe(200)
    expect(after.body).toEqual(before.body)
    const afterBrk = await brk("/api/dashboard/breakdown?month=2026-10")
    expect(afterBrk.status).toBe(200)
    expect(afterBrk.body).toEqual(beforeBrk.body)
    const team = await dash(`/api/dashboard?month=2026-10&team=${T.platform}`)
    expect(team.status).toBe(200)
  })

  it("other read errors on invoice_overrides still fail loudly", async () => {
    failing.add("invoice_overrides")
    expect((await dash("/api/dashboard?month=2026-10")).status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// Cursor seat types per person (migration 026)
// ---------------------------------------------------------------------------

describe("Cursor seat attribution (migration 026)", () => {
  // November fixture: Cursor dave $30 (identity), total $250. October: Cursor dave $30, total $105.
  const RATES = [
    { seat_type: "standard", effective_month: "2000-01-01", monthly_rate_usd: "40.00" },
    { seat_type: "premium", effective_month: "2000-01-01", monthly_rate_usd: "80.00" },
    { seat_type: "free", effective_month: "2000-01-01", monthly_rate_usd: "0.00" },
  ]
  const seat = (person_id: string, month: string, seat_type: string) => ({ person_id, effective_month: `${month}-01`, seat_type, source: "admin" })
  const missing = { code: "PGRST205", message: "Could not find the table 'public.cursor_seat_assignments' in the schema cache" }
  const split = (products: { product: string; cost: number }[] | undefined) =>
    Object.fromEntries((products ?? []).map((p) => [p.product, p.cost]))
  const cursorTool = (body: DashboardBody) => body.tools.find((t) => t.id === P_CURSOR)!
  const P_CURSOR = "prov-cursor"

  beforeEach(() => {
    const org = orgData()
    seed(org)
    tables.person_identities = org.identities as unknown as Row[]
    tables.cursor_seat_rates = RATES
    // Dave Premium, Alice Standard, Bob Free, Carol unassigned, all from November.
    tables.cursor_seat_assignments = [seat(PE.dave, "2026-11", "premium"), seat(PE.alice, "2026-11", "standard"), seat(PE.bob, "2026-11", "free"), seat(PE.carol, "2026-11", "none")]
  })

  it("attributes each person's seat fee to them, their team and Cursor totals; earlier months are unchanged", async () => {
    const { status, body } = await dash("/api/dashboard?month=2026-11")
    expect(status).toBe(200)
    expect(body.kpis.totalSpend).toBe(NOV_TOTAL + 120)
    expect(cursorTool(body).monthlySpend).toBe(30 + 120)
    expect(split(cursorTool(body).products)).toEqual({ grok_bot: 0, bugbot: 0, agent_chat: 30, seats: 120 })
    const oct = await dash("/api/dashboard?month=2026-10")
    expect(oct.body.kpis.totalSpend).toBe(105)

    const brkBody = (await brk("/api/dashboard/breakdown?month=2026-11")).body
    expect(brkBody.total.cost).toBe(NOV_TOTAL + 120)
    const person = (id: string) => brkBody.person.find((p) => p.id === id)?.cost ?? 0
    const before = (await (async () => {
      tables.cursor_seat_assignments = []
      return (await brk("/api/dashboard/breakdown?month=2026-11")).body
    })())
    const personBefore = (id: string) => before.person.find((p) => p.id === id)?.cost ?? 0
    expect(person(PE.dave) - personBefore(PE.dave)).toBe(80)
    expect(person(PE.alice) - personBefore(PE.alice)).toBe(40)
    expect(person(PE.bob)).toBe(personBefore(PE.bob)) // Free: $0
    expect(person(PE.carol)).toBe(personBefore(PE.carol)) // unassigned: $0
    expect((brkBody.team.find((t) => t.id === T.data)?.cost ?? 0) - (before.team.find((t) => t.id === T.data)?.cost ?? 0)).toBe(80)
  })

  it("a person filter shows that person's seat fee; a provider filter for another provider shows none", async () => {
    const dave = await dash(`/api/dashboard?month=2026-11&person=${PE.dave}`)
    expect(dave.body.kpis.totalSpend).toBe(30 + 80)
    const cursor = await dash("/api/dashboard?month=2026-11&provider=cursor")
    expect(cursor.body.kpis.totalSpend).toBe(30 + 120)
    const openai = await dash("/api/dashboard?month=2026-11&provider=openai")
    expect(openai.body.kpis.totalSpend).toBe(50)
  })

  it("changing a person's seat type updates their attributed seat cost", async () => {
    tables.cursor_seat_assignments = [seat(PE.dave, "2026-11", "standard")]
    expect((await dash(`/api/dashboard?month=2026-11&person=${PE.dave}`)).body.kpis.totalSpend).toBe(30 + 40)
    tables.cursor_seat_assignments = [seat(PE.dave, "2026-11", "none")]
    expect((await dash(`/api/dashboard?month=2026-11&person=${PE.dave}`)).body.kpis.totalSpend).toBe(30)
  })

  it("rates are configurable: a new Premium rate changes the attributed cost with no code change", async () => {
    tables.cursor_seat_rates = [...RATES, { seat_type: "premium", effective_month: "2026-11-01", monthly_rate_usd: "100.00" }]
    expect((await dash(`/api/dashboard?month=2026-11&person=${PE.dave}`)).body.kpis.totalSpend).toBe(30 + 100)
  })

  it("no double-count against the invoice override: an invoiced Cursor month totals the invoice, seats inside it", async () => {
    tables.cursor_seat_assignments = [seat(PE.dave, "2026-10", "premium"), seat(PE.alice, "2026-10", "standard")]
    tables.invoice_overrides = [
      { id: "io1", provider_id: P_CURSOR, month: "2026-10-01", billed_amount_usd: "200.00", credits_usd: null, notes: null, invoice_ids: [], entered_by: "a@x", entered_at: "2026-11-04T00:00:00Z" },
    ]
    const { body } = await dash("/api/dashboard?month=2026-10")
    expect(cursorTool(body).monthlySpend).toBe(200)
    expect(body.kpis.totalSpend).toBe(105 - 30 + 200)
    expect(split(cursorTool(body).products)).toEqual({ grok_bot: 0, bugbot: 0, agent_chat: 80, seats: 120 })
    const b = (await brk("/api/dashboard/breakdown?month=2026-10")).body
    expect(b.total.cost).toBe(105 - 30 + 200)
    const dave = await dash(`/api/dashboard?month=2026-10&person=${PE.dave}`)
    expect(dave.body.kpis.totalSpend).toBe(80 + 80) // seat $80 + usage $30 scaled to the $80 remainder
    // November (no invoice) still adds seats on top of usage.
    expect((await dash("/api/dashboard?month=2026-11")).body.kpis.totalSpend).toBe(NOV_TOTAL + 120)
  })

  it("a recurring Cursor seat line is not counted on top of per-person seats", async () => {
    tables.recurring_costs = [
      { id: "rc-cursor", provider_id: P_CURSOR, start_month: "2026-10-01", end_month: null, monthly_cost_usd: "5840.00", seats: null, price_per_seat: null, notes: null },
    ]
    const nov = await dash("/api/dashboard?month=2026-11")
    expect(cursorTool(nov.body).monthlySpend).toBe(30 + 120)
    const oct = await dash("/api/dashboard?month=2026-10")
    expect(cursorTool(oct.body).monthlySpend).toBe(30 + 5840) // no seats in October: the recurring line stays
  })

  it("safe without migration 026: responses are exactly as without seats", async () => {
    tables.cursor_seat_assignments = []
    const before = await dash("/api/dashboard?month=2026-11")
    const beforeBrk = await brk("/api/dashboard/breakdown?month=2026-11")
    const beforeTeam = await dash(`/api/dashboard?month=2026-11&team=${T.data}`)
    tables.cursor_seat_assignments = [seat(PE.dave, "2026-11", "premium")]
    tableErrors.cursor_seat_assignments = missing
    tableErrors.cursor_seat_rates = { ...missing, message: "Could not find the table 'public.cursor_seat_rates' in the schema cache" }
    const after = await dash("/api/dashboard?month=2026-11")
    expect(after.status).toBe(200)
    expect(after.body).toEqual(before.body)
    expect(after.body.kpis.totalSpend).toBe(NOV_TOTAL)
    const afterBrk = await brk("/api/dashboard/breakdown?month=2026-11")
    expect(afterBrk.status).toBe(200)
    expect(afterBrk.body).toEqual(beforeBrk.body)
    const afterTeam = await dash(`/api/dashboard?month=2026-11&team=${T.data}`)
    expect(afterTeam.body).toEqual(beforeTeam.body)
  })

  it("other read errors on the seat tables still fail loudly", async () => {
    failing.add("cursor_seat_assignments")
    expect((await dash("/api/dashboard?month=2026-11")).status).toBe(500)
  })
})
