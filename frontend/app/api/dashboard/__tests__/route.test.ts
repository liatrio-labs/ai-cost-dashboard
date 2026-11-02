/**
 * @jest-environment node
 *
 * GET /api/dashboard (issue #8). The unfiltered response must stay exactly as
 * it was before org filters existed; filters narrow KPIs, tools and trends.
 */

import { NextRequest } from "next/server"
import { orgData, PE, T, D } from "@/lib/org/test-fixtures"
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

async function get(qs: string) {
  const res = await GET(new NextRequest(`http://localhost/api/dashboard${qs}`))
  return { status: res.status, body: await res.json() }
}

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
