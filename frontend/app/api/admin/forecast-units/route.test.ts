/**
 * @jest-environment node
 *
 * /api/admin/forecast-units (issue #9) against the in-memory admin fake. The
 * app_settings reads/writes are replaced with an in-memory overrides map.
 */

import { NextRequest } from "next/server"
import { FakeSupabase } from "@/lib/org/admin/testing/fake-supabase"
import { attributedRows } from "@/lib/org/dashboard-fixtures"
import { D, T, orgData } from "@/lib/org/test-fixtures"
import type { UnitOverrides } from "@/lib/forecast-settings"

const mockAuth = { user: null as null | { id: string; email: string } }
const mockState = { db: null as unknown as FakeSupabase, overrides: {} as UnitOverrides }

jest.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}))
jest.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: mockAuth.user }, error: null }) },
  }),
}))
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockState.db }))
jest.mock("@/lib/forecast-settings", () => {
  const actual = jest.requireActual("@/lib/forecast-settings")
  return {
    ...actual,
    getForecastSettings: async () => actual.FORECAST_DEFAULTS,
    getForecastUnitOverrides: async () => mockState.overrides,
    setForecastUnitOverride: async (level: string, key: string, o: { plateauUsd: number | null; headcount: number | null }) => {
      const next = { ...mockState.overrides }
      const k = actual.unitOverrideKey(level, key)
      if (o.plateauUsd == null && o.headcount == null) delete next[k]
      else next[k] = o
      mockState.overrides = next
      return next
    },
  }
})

import { GET, PUT } from "./route"

const ADMIN = { id: "u-admin", email: "admin@example.com" }

interface Unit {
  key: string
  name: string
  share: number
  plateau: number
  allocatedPlateau: number
  override: unknown
  nextMonth: { month: string; total: number } | null
}
interface Payload {
  orgPlateau: number
  trailingMonths: string[]
  team: Unit[]
  department: Unit[]
  error?: string
}

async function call(method: "GET" | "PUT", body?: unknown) {
  const req = new NextRequest(new URL("/api/admin/forecast-units", "http://localhost"), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  })
  const handler = method === "GET" ? GET : PUT
  const res = await handler(req, { params: Promise.resolve({}) })
  return { status: res.status, body: (await res.json()) as Payload }
}

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
})
afterAll(() => {
  process.env = savedEnv
})
beforeEach(() => {
  const org = orgData()
  mockState.db = new FakeSupabase({
    departments: org.departments,
    teams: org.teams,
    cost_records_daily_attributed: attributedRows(org),
  })
  mockState.overrides = {}
  mockAuth.user = ADMIN
})

describe("/api/admin/forecast-units", () => {
  it("lists every team and department plus Unassigned with allocated plateaus", async () => {
    const { status, body } = await call("GET")
    expect(status).toBe(200)
    expect(body.orgPlateau).toBe(58000)
    expect(body.trailingMonths).toEqual(["2026-09", "2026-10", "2026-11"])
    expect(body.team.map((u) => u.key).sort()).toEqual([T.data, T.field, T.orphan, T.platform, "unassigned"].sort())
    expect(body.department.map((u) => u.key).sort()).toEqual([D.eng, D.sales, "unassigned"].sort())
    expect(body.team.find((u) => u.key === T.data)).toMatchObject({ name: "Data", override: null })
    expect(body.team.find((u) => u.key === T.orphan)).toMatchObject({ share: 0, plateau: 0, nextMonth: { month: "2026-12", total: 0 } })
    const sum = body.team.reduce((a, u) => a + u.allocatedPlateau, 0)
    expect(Math.abs(sum - 58000)).toBeLessThanOrEqual(1)
  })

  it("sets and clears one unit's override without touching the others", async () => {
    const before = (await call("GET")).body
    const set = await call("PUT", { level: "team", key: T.data, plateauUsd: 1000 })
    expect(set.status).toBe(200)
    expect(set.body.team.find((u) => u.key === T.data)).toMatchObject({ plateau: 1000, override: { plateauUsd: 1000, headcount: null } })
    for (const u of set.body.team.filter((x) => x.key !== T.data)) {
      expect(u).toEqual(before.team.find((b) => b.key === u.key))
    }
    expect(set.body.department).toEqual(before.department)

    const cleared = await call("PUT", { level: "team", key: T.data, plateauUsd: null, headcount: null })
    expect(cleared.body).toEqual(before)
  })

  it("accepts a headcount override for Unassigned", async () => {
    const { status, body } = await call("PUT", { level: "department", key: "unassigned", headcount: 16 })
    expect(status).toBe(200)
    expect(body.department.find((u) => u.key === "unassigned")).toMatchObject({ plateau: 5800 })
  })

  it("rejects unknown units and bad values", async () => {
    expect((await call("PUT", { level: "team", key: "nope", plateauUsd: 1 })).status).toBe(404)
    expect((await call("PUT", { level: "team", key: T.data, plateauUsd: -1 })).status).toBe(400)
    expect((await call("PUT", { level: "person", key: T.data, plateauUsd: 1 })).status).toBe(400)
    expect(mockState.overrides).toEqual({})
  })

  it("requires an admin", async () => {
    mockAuth.user = null
    expect((await call("GET")).status).toBe(401)
    mockAuth.user = { id: "u-out", email: "someone@elsewhere.test" }
    expect((await call("PUT", { level: "team", key: T.data, plateauUsd: 1 })).status).toBe(403)
  })
})
