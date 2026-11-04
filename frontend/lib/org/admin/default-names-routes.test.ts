/**
 * @jest-environment node
 *
 * Route tests for default display names (issue #66):
 * POST /api/admin/org/people/default-names (admin-only backfill) and the
 * admin add-person paths that now derive a name for first.last@liatrio.com.
 */

import { NextRequest } from "next/server"
import type { FakeSupabase } from "./testing/fake-supabase"
import { seedDb } from "./testing/seed"
import { T } from "../test-fixtures"

const mockAuth = { user: null as null | { id: string; email: string } }
const mockState = { db: null as unknown as FakeSupabase }

jest.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}))
jest.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: mockAuth.user }, error: null }) },
  }),
}))
jest.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockState.db,
  refreshDailyAggregates: async () => undefined,
}))

import * as defaultNames from "@/app/api/admin/org/people/default-names/route"
import * as people from "@/app/api/admin/org/people/route"
import * as assign from "@/app/api/admin/org/unassigned/assign/route"

const ADMIN = { id: "u-admin", email: "admin@example.com" }

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
async function call(handler: unknown, body?: unknown) {
  const req = new NextRequest(new URL("/api/admin/org/people", "http://localhost"), {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  })
  const res = await (handler as Handler)(req, { params: Promise.resolve({}) })
  return { status: res.status, body: await res.json() }
}
const rows = (t: string) => mockState.db.table(t)
const nameOf = (email: string) => rows("people").find((p) => p.email === email)?.display_name

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
})
afterAll(() => {
  process.env = savedEnv
})
beforeEach(() => {
  mockState.db = seedDb()
  mockAuth.user = ADMIN
  rows("people").push(
    { id: "p-jane", email: "jane.doe@liatrio.com", display_name: "jane.doe", team_id: null, active: true },
    { id: "p-mj", email: "mary-jane.smith@liatrio.com", display_name: null, team_id: null, active: true },
    { id: "p-bob-jones", email: "bob.jones@liatrio.com", display_name: "Bobby", team_id: null, active: true }
  )
})

describe("POST /people/default-names", () => {
  it("fills placeholder names, keeps manual ones, and reports the count", async () => {
    const manual = rows("people").filter((p) => p.id !== "p-jane" && p.id !== "p-mj").map((p) => ({ ...p }))
    const res = await call(defaultNames.POST)
    expect(res).toEqual({ status: 200, body: { updated: 2 } })
    expect(nameOf("jane.doe@liatrio.com")).toBe("Jane Doe")
    expect(nameOf("mary-jane.smith@liatrio.com")).toBe("Mary-Jane Smith")
    for (const p of manual) expect(rows("people").find((r) => r.id === p.id)).toEqual(p)
  })

  it("is idempotent", async () => {
    await call(defaultNames.POST)
    expect(await call(defaultNames.POST)).toEqual({ status: 200, body: { updated: 0 } })
  })

  it("is admin-only", async () => {
    mockAuth.user = null
    expect((await call(defaultNames.POST)).status).toBe(401)
    mockAuth.user = { id: "u-out", email: "someone@elsewhere.test" }
    expect((await call(defaultNames.POST)).status).toBe(403)
    expect(nameOf("jane.doe@liatrio.com")).toBe("jane.doe")
  })
})

describe("admin add-person paths", () => {
  it("POST /people derives a name when none (or a placeholder) is given and keeps a typed one", async () => {
    expect((await call(people.POST, { email: "ann.lee@liatrio.com" })).body.display_name).toBe("Ann Lee")
    expect((await call(people.POST, { email: "tom.hall@liatrio.com", display_name: "tom.hall" })).body.display_name).toBe("Tom Hall")
    expect((await call(people.POST, { email: "kim.wu@liatrio.com", display_name: "Kimberly" })).body.display_name).toBe("Kimberly")
    expect((await call(people.POST, { email: "solo@liatrio.com" })).body.display_name).toBeNull()
  })

  it("unassigned/assign derives a name for a new person", async () => {
    const res = await call(assign.POST, { kind: "person", email: "ann.lee@liatrio.com", team_id: T.platform })
    expect(res.status).toBe(201)
    expect(nameOf("ann.lee@liatrio.com")).toBe("Ann Lee")
  })
})
