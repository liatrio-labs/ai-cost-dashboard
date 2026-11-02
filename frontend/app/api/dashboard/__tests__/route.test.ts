/**
 * @jest-environment node
 *
 * GET /api/dashboard (issue #8). The unfiltered response must stay exactly as
 * it was before org filters existed; filters narrow KPIs, tools and trends.
 */

import { NextRequest } from "next/server"
import { orgData, PE, T } from "@/lib/org/test-fixtures"
import { attributedRows, emptyOrg, mockSupabase, plainDailyRows, providerRows, PROV } from "@/lib/dashboard/test-fixtures"

let tables: Record<string, unknown[]> = {}
const calls: string[] = []

jest.mock("next/headers", () => ({ cookies: async () => ({}) }))
jest.mock("@/lib/forecast-settings", () => ({
  getForecastSettings: async () => ({ employees: 100, baselineEmployees: 100, baselineUsd: 1000, perPersonPct: 2 }),
  plateauForEmployees: () => 1000,
}))
jest.mock("@/lib/db", () => ({
  requireAuth: async () => ({ id: "u1" }),
  createClient: async () => mockSupabase(tables, calls),
  successResponse: (data: unknown) => Response.json(data),
  errorResponse: (message: string, status = 500) => Response.json({ error: message }, { status }),
}))

// Imported after the mocks.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GET } = require("../route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GET: GET_BREAKDOWN } = require("../breakdown/route")

async function call(handler: typeof GET, path: string, qs: string) {
  const res = await handler(new NextRequest(`http://localhost${path}${qs}`))
  return { status: res.status, body: await res.json() }
}
const get = (qs: string) => call(GET, "/api/dashboard", qs)
const getBreakdown = (qs: string) => call(GET_BREAKDOWN, "/api/dashboard/breakdown", qs)

beforeEach(() => {
  calls.length = 0
  tables = {
    providers: providerRows,
    cost_records_daily: plainDailyRows(),
    cost_records_daily_attributed: attributedRows(orgData()),
  }
})

describe("GET /api/dashboard without filters (regression)", () => {
  it("returns the same response fields and totals as before org filters", async () => {
    const { status, body } = await get("?month=2026-11")
    expect(status).toBe(200)
    expect(body).toMatchSnapshot()
    expect(body.kpis.totalSpend).toBe(347)
    expect(body.kpis.prevSpend).toBe(150)
    // Never touches the attributed view or the org tables.
    expect(calls).toEqual(["providers", "cost_records_daily"])
  })

  it("is unaffected when no org structure exists", async () => {
    tables.cost_records_daily_attributed = attributedRows(emptyOrg())
    const { body } = await get("?month=2026-11")
    expect(body).toMatchSnapshot()
  })
})

describe("GET /api/dashboard with filters", () => {
  it("team filter narrows KPIs, tools and trends to that team", async () => {
    const { body } = await get(`?month=2026-11&team=${T.data}`)
    expect(body.filters).toEqual({ team: T.data })
    expect(body.kpis.totalSpend).toBe(90)
    expect(body.kpis.prevSpend).toBe(50)
    expect(body.tools.map((t: { name: string; monthlySpend: number }) => [t.name, t.monthlySpend])).toEqual([
      ["OpenAI API", 60],
      ["Cursor", 30],
    ])
    expect(body.trends).toEqual([
      { month: "2026-10", total: 50, openai: 30, cursor: 20 },
      { month: "2026-11", total: 90, openai: 60, cursor: 30 },
    ])
    expect(calls).toContain("cost_records_daily_attributed")
    expect(calls).not.toContain("cost_records_daily")
  })

  it("person filter returns only that person", async () => {
    const { body } = await get(`?month=2026-11&person=${PE.bob}`)
    expect(body.kpis.totalSpend).toBe(65)
    expect(body.byModel.map((m: { model: string }) => m.model)).toEqual(["claude-sonnet", "gpt-5"])
  })

  it("provider filter alone narrows to one provider", async () => {
    const { body } = await get(`?month=2026-11&provider=${PROV.windsurf}`)
    expect(body.kpis.totalSpend).toBe(50)
    expect(body.kpis.activeProviders).toBe(1)
  })

  it("filters with no org structure land everything in Unassigned", async () => {
    tables.cost_records_daily_attributed = attributedRows(emptyOrg())
    expect((await get("?month=2026-11&department=unassigned")).body.kpis.totalSpend).toBe(347)
    expect((await get(`?month=2026-11&team=${T.data}`)).body.kpis.totalSpend).toBe(0)
  })
})

describe("GET /api/dashboard/breakdown", () => {
  it("reconciles every level with the unfiltered dashboard total", async () => {
    tables.departments = orgData().departments
    tables.teams = orgData().teams
    tables.people = orgData().people
    tables.org_api_keys = orgData().apiKeys
    const [{ body: dash }, { status, body }] = await Promise.all([get("?month=2026-11"), getBreakdown("?month=2026-11")])
    expect(status).toBe(200)
    expect(body.orgConfigured).toBe(true)
    expect(body.total.spend).toBe(dash.kpis.totalSpend)
    for (const level of ["departments", "teams", "people", "apiKeys"]) {
      const s = body[level].reduce((a: number, e: { spend: number }) => a + e.spend, 0)
      expect(s).toBeCloseTo(dash.kpis.totalSpend, 6)
    }
    expect(body.people[0]).toMatchObject({ label: "Alice", spend: 160, changePercent: 100 })
  })

  it("with no org tables (migration not applied), returns everything in Unassigned", async () => {
    tables.cost_records_daily_attributed = attributedRows(emptyOrg())
    const { status, body } = await getBreakdown("?month=2026-11")
    expect(status).toBe(200)
    expect(body.orgConfigured).toBe(false)
    for (const level of ["departments", "teams", "people", "apiKeys"]) {
      expect(body[level]).toEqual([expect.objectContaining({ key: "unassigned", spend: 347, prevSpend: 150 })])
    }
  })

  it("applies filters", async () => {
    tables.people = orgData().people
    const { body } = await getBreakdown(`?month=2026-11&team=${T.data}`)
    expect(body.total.spend).toBe(90)
    expect(body.people.map((e: { label: string }) => e.label)).toEqual(["Alice", "Dave", "Unassigned"])
  })
})
