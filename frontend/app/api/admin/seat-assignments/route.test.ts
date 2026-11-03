/**
 * @jest-environment node
 *
 * /api/admin/seat-assignments and the seat-group paths of /api/admin/entries
 * (issue #26). The real requireAdmin runs against a mocked Supabase auth
 * client; the service-role client is the in-memory fake, with an rpc() that
 * does what replace_seat_group() (migration 016) does, checks included.
 * No network, no database.
 */

import { NextRequest } from "next/server"
import { FakeSupabase } from "@/lib/org/admin/testing/fake-supabase"
import { orgData } from "@/lib/org/test-fixtures"
import { sumMicros, toMicros } from "@/lib/org/seat-assignments"
import { CLAUDE_MAX, PROD_TOTAL, prodSeatRows } from "@/lib/org/seat-fixtures"

const mockAuth = { user: null as null | { id: string; email: string } }
const mockState = { db: null as unknown as SeatFake, refreshes: 0 }

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
  refreshDailyAggregates: async () => {
    mockState.refreshes += 1
  },
}))

import * as seats from "./route"
import * as entries from "@/app/api/admin/entries/route"

type Row = Record<string, unknown>

/** FakeSupabase plus replace_seat_group(), mirroring the SQL function's checks. */
class SeatFake extends FakeSupabase {
  rpcArgs: Row[] = []
  async rpc(name: string, args?: Row) {
    this.rpcCalls.push(name)
    if (name !== "replace_seat_group") return { data: null, error: null }
    this.rpcArgs.push(args ?? {})
    const ids = (args?.p_delete_ids as string[]) ?? []
    const next = (args?.p_rows as Row[]) ?? []
    const table = this.table("cost_records")
    const old = table.filter((r) => ids.includes(r.id as string) && ["manual_entry", "csv_import"].includes(r.collection_method as string))
    const fail = (message: string) => ({ data: null, error: { code: "P0001", message } })
    if (!ids.length || !next.length) return fail("replace_seat_group: nothing to replace")
    if (old.length !== new Set(ids).size) return fail("replace_seat_group: rows changed since loaded")
    const provider = old[0].provider_id
    if (old.some((r) => r.provider_id !== provider) || next.some((r) => r.provider_id !== provider || Number(r.cost_usd) < 0)) {
      return fail("replace_seat_group: bad provider or cost")
    }
    if (sumMicros(next as { cost_usd: number }[]) !== sumMicros(old as { cost_usd: number }[])) {
      return fail("replace_seat_group: totals do not reconcile")
    }
    for (const r of old) table.splice(table.indexOf(r), 1)
    for (const r of next) table.push({ ...r, id: this.nextId("cost_records"), collection_method: "manual_entry" })
    return { data: next.length, error: null }
  }
}

const PROVIDERS = [
  { id: CLAUDE_MAX, name: "claude-max", display_name: "Claude Ultra", is_active: true, metadata: { collection_method: "manual", cost_basis: "seat_subscription", billing: "seat" } },
  { id: "prov-lovable", name: "lovable", display_name: "Lovable", is_active: true, metadata: { collection_method: "manual", cost_basis: "manual", billing: "manual" } },
  { id: "prov-openai", name: "openai", display_name: "OpenAI API", is_active: true, metadata: { collection_method: "api" } },
]

function seed() {
  const org = orgData()
  const apiRow = { ...prodSeatRows()[0], id: "api-1", provider_id: "prov-openai", collection_method: "api_automated", metadata: {} }
  return new SeatFake({
    providers: PROVIDERS,
    people: org.people.map((p) => ({ ...p, active: true })),
    cost_records: [...prodSeatRows(), apiRow],
  })
}

const ADMIN = { id: "u-admin", email: "admin@example.com" }
const OUTSIDER = { id: "u-out", email: "someone@elsewhere.test" }

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
async function call(handler: unknown, method: string, path: string, body?: unknown) {
  const req = new NextRequest(new URL(path, "http://localhost"), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  })
  const res = await (handler as Handler)(req, { params: Promise.resolve({}) })
  return { status: res.status, body: await res.json() }
}

const seatRowsOf = (month?: string) =>
  mockState.db
    .table("cost_records")
    .filter((r) => r.provider_id === CLAUDE_MAX && (!month || (r.metadata as Row)?.month === month))
const claudeTotal = () => sumMicros(seatRowsOf() as { cost_usd: number }[])

const APRIL = {
  provider_id: CLAUDE_MAX,
  month: "2026-04",
  expected_total_usd: 2800,
  assignments: [
    { person_email: "alice@liatrio.com", seats: 1 },
    { person_email: "bob@liatrio.com", seats: 2 },
    { person_email: "New.Hire@liatrio.com", seats: 1, cost_usd: 150 },
  ],
}

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
})
afterAll(() => {
  process.env = savedEnv
})
beforeEach(() => {
  mockState.db = seed()
  mockState.refreshes = 0
  mockAuth.user = ADMIN
})

describe("seat-assignments auth", () => {
  it.each([
    ["GET", seats.GET, undefined],
    ["PUT", seats.PUT, APRIL],
  ])("%s is admin-only", async (method, handler, body) => {
    mockAuth.user = null
    expect((await call(handler, method, "/api/admin/seat-assignments", body)).status).toBe(401)
    mockAuth.user = OUTSIDER
    expect((await call(handler, method, "/api/admin/seat-assignments", body)).status).toBe(403)
    expect(mockState.db.rpcCalls).toEqual([])
    expect(seatRowsOf()).toHaveLength(5)
  })
})

describe("GET /api/admin/seat-assignments", () => {
  it("lists seat-based providers (Claude Ultra, slug claude-max), their months and people", async () => {
    const res = await call(seats.GET, "GET", "/api/admin/seat-assignments")
    expect(res.status).toBe(200)
    expect(res.body.providers).toEqual([{ id: CLAUDE_MAX, name: "claude-max", display_name: "Claude Ultra" }])
    expect(res.body.groups.map((g: { month: string }) => g.month)).toEqual(["2026-08", "2026-06", "2026-05", "2026-04", "2026-03"])
    expect(res.body.groups.reduce((s: number, g: { total_usd: number }) => s + g.total_usd, 0)).toBe(PROD_TOTAL)
    expect(res.body.people.map((p: { email: string }) => p.email)).toContain("alice@liatrio.com")
  })
})

describe("PUT /api/admin/seat-assignments", () => {
  it("splits the month into people plus a remainder through the atomic RPC, total unchanged", async () => {
    const res = await call(seats.PUT, "PUT", "/api/admin/seat-assignments", APRIL)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total_usd: 2800, total_seats: 14, remainder: { seats: 10, cost_usd: 2050 }, rows_written: 4 })
    expect(mockState.db.rpcCalls).toEqual(["replace_seat_group"])
    expect(mockState.db.rpcArgs[0].p_delete_ids).toEqual(["cm-2026-04"])
    const april = seatRowsOf("2026-04")
    expect(april).toHaveLength(4)
    expect(sumMicros(april as { cost_usd: number }[])).toBe(toMicros(2800))
    expect(new Set(april.map((r) => (r.metadata as Row).seat_group_id)).size).toBe(1)
    expect(april.map((r) => ((r.metadata as Row).attribution as Row).person_email ?? null).sort()).toEqual(
      ["alice@liatrio.com", "bob@liatrio.com", "new.hire@liatrio.com", null].sort()
    )
    expect(claudeTotal()).toBe(toMicros(PROD_TOTAL))
    // Other months untouched.
    expect(seatRowsOf("2026-03")).toEqual(prodSeatRows().filter((r) => r.id === "cm-2026-03"))
    expect(mockState.refreshes).toBe(1)
  })

  it("adds an unknown email to people (no team) so the spend lands on a person", async () => {
    await call(seats.PUT, "PUT", "/api/admin/seat-assignments", APRIL)
    const added = mockState.db.table("people").filter((p) => p.email === "new.hire@liatrio.com")
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ team_id: null, display_name: null })
    expect(mockState.db.table("people")).toHaveLength(6)
  })

  it("re-assigning replaces the set without changing the total", async () => {
    await call(seats.PUT, "PUT", "/api/admin/seat-assignments", APRIL)
    const groupId = (seatRowsOf("2026-04")[0].metadata as Row).seat_group_id
    const res = await call(seats.PUT, "PUT", "/api/admin/seat-assignments", {
      ...APRIL,
      assignments: [{ person_email: "dave@liatrio.com", seats: 3 }],
    })
    expect(res.status).toBe(200)
    const april = seatRowsOf("2026-04")
    expect(april).toHaveLength(2)
    expect(april.every((r) => (r.metadata as Row).seat_group_id === groupId)).toBe(true)
    expect(sumMicros(april as { cost_usd: number }[])).toBe(toMicros(2800))
    expect(claudeTotal()).toBe(toMicros(PROD_TOTAL))
    expect(mockState.db.rpcArgs[1].p_delete_ids).toHaveLength(4)
  })

  it("an empty list collapses the month back to one plain entry", async () => {
    await call(seats.PUT, "PUT", "/api/admin/seat-assignments", APRIL)
    const res = await call(seats.PUT, "PUT", "/api/admin/seat-assignments", { ...APRIL, assignments: [] })
    expect(res.status).toBe(200)
    const april = seatRowsOf("2026-04")
    expect(april).toHaveLength(1)
    expect(april[0]).toMatchObject({ cost_usd: 2800, request_count: 14 })
    expect((april[0].metadata as Row).attribution).toBeUndefined()
  })

  it.each([
    ["more seats than the month has", { assignments: [{ person_email: "alice@liatrio.com", seats: 15 }] }, 400, /reconcile/],
    ["more money than the month has", { assignments: [{ person_email: "alice@liatrio.com", seats: 1, cost_usd: 5000 }] }, 400, /reconcile/],
    ["a stale expected total", { expected_total_usd: 2600 }, 409, /reconcile/],
    ["an unknown provider", { provider_id: "prov-nope" }, 404, /Unknown provider/],
    ["a non-seat manual provider", { provider_id: "prov-lovable" }, 400, /not a seat-based tool/],
    ["an API provider", { provider_id: "prov-openai" }, 400, /not a seat-based tool/],
    ["a month with no seat entry", { month: "2026-07" }, 404, /No Claude Ultra seat entry/],
    ["a bad month", { month: "2026-4" }, 400, /YYYY-MM/],
    ["fractional seats", { assignments: [{ person_email: "alice@liatrio.com", seats: 1.5 }] }, 400, /whole number/],
    ["a duplicate person", { assignments: [{ person_email: "alice@liatrio.com", seats: 1 }, { person_email: "Alice@liatrio.com", seats: 1 }] }, 400, /twice/],
  ])("rejects %s and writes nothing", async (_label, patch, status, message) => {
    const res = await call(seats.PUT, "PUT", "/api/admin/seat-assignments", { ...APRIL, ...patch })
    expect(res.status).toBe(status)
    expect(res.body.error).toMatch(message)
    expect(mockState.db.rpcCalls).toEqual([])
    expect(seatRowsOf()).toEqual(prodSeatRows())
    expect(mockState.db.table("people")).toHaveLength(5)
  })

  it("surfaces an RPC refusal (rows changed underneath) and leaves the month as it was", async () => {
    const db = mockState.db
    const orig = db.rpc.bind(db)
    db.rpc = async (name: string, args?: Row) => orig(name, { ...args, p_delete_ids: [...((args?.p_delete_ids as string[]) ?? []), "gone"] })
    const res = await call(seats.PUT, "PUT", "/api/admin/seat-assignments", APRIL)
    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/changed since loaded/)
    expect(seatRowsOf()).toEqual(prodSeatRows())
  })
})

describe("/api/admin/entries with split months", () => {
  beforeEach(async () => {
    await call(seats.PUT, "PUT", "/api/admin/seat-assignments", APRIL)
  })
  const groupId = () => (seatRowsOf("2026-04")[0].metadata as Row).seat_group_id as string

  it("DELETE ?seat_group_id removes the whole month's set and nothing else", async () => {
    const res = await call(entries.DELETE, "DELETE", `/api/admin/entries?seat_group_id=${groupId()}`)
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(4)
    expect(seatRowsOf("2026-04")).toHaveLength(0)
    expect(claudeTotal()).toBe(toMicros(PROD_TOTAL - 2800))
    expect(mockState.db.table("cost_records").some((r) => r.id === "api-1")).toBe(true)
  })

  it("DELETE ?seat_group_id is admin-only and 404s on an unknown group", async () => {
    mockAuth.user = OUTSIDER
    expect((await call(entries.DELETE, "DELETE", `/api/admin/entries?seat_group_id=${groupId()}`)).status).toBe(403)
    mockAuth.user = ADMIN
    expect((await call(entries.DELETE, "DELETE", "/api/admin/entries?seat_group_id=nope")).status).toBe(404)
    expect(seatRowsOf("2026-04")).toHaveLength(4)
  })

  it("refuses to edit or delete one row of a split month", async () => {
    const id = seatRowsOf("2026-04")[0].id as string
    const patch = await call(entries.PATCH, "PATCH", "/api/admin/entries", { id, cost_usd: 1 })
    expect(patch.status).toBe(400)
    expect(patch.body.error).toMatch(/Seat assignments/)
    const del = await call(entries.DELETE, "DELETE", `/api/admin/entries?id=${id}`)
    expect(del.status).toBe(400)
    expect(seatRowsOf("2026-04")).toHaveLength(4)
    expect(claudeTotal()).toBe(toMicros(PROD_TOTAL))
  })

  it("plain (un-split) entries still edit and delete one at a time", async () => {
    const patch = await call(entries.PATCH, "PATCH", "/api/admin/entries", { id: "cm-2026-03", seats: 13, price_per_seat: 200 })
    expect(patch.status).toBe(200)
    expect(seatRowsOf("2026-03")[0]).toMatchObject({ cost_usd: 2600, request_count: 13 })
    expect((await call(entries.DELETE, "DELETE", "/api/admin/entries?id=cm-2026-03")).status).toBe(200)
    expect(seatRowsOf("2026-03")).toHaveLength(0)
  })
})
