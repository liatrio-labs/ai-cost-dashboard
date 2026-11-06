/**
 * @jest-environment node
 *
 * /api/admin/org/cursor-seats (migration 026): state, per-person seat type,
 * monthly rates, and the roster CSV backfill. The real requireAdmin runs
 * against a mocked Supabase auth client; the service-role client is the
 * in-memory fake, with the two write functions emulated like 026's SQL.
 * No network, no database.
 */

import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"
import { FakeSupabase } from "@/lib/org/admin/testing/fake-supabase"
import { parseRoster } from "@/lib/cursor-seats"

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

import * as stateRoute from "./route"
import * as assignRoute from "./assign/route"
import * as ratesRoute from "./rates/route"
import * as importRoute from "./import/route"

const ROSTER_CSV = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "..", "database", "seeds", "cursor-seat-roster-2026-11-05.csv"), "utf8")
const ADMIN = { id: "u-admin", email: "admin@example.com" }
const OUTSIDER = { id: "u-out", email: "someone@elsewhere.test" }
const CURSOR = "prov-cursor"

const slug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")

/**
 * The org's people: every roster person except Yujie Wu (to show an unmatched
 * row), plus one person not on the roster. Email rows are stored upper-case.
 */
function people() {
  const out = parseRoster(ROSTER_CSV)
    .filter((r) => r.name !== "Yujie Wu")
    .map((r, i) => ({
      id: `p${i}`,
      email: r.email ? r.email.toUpperCase() : `${slug(r.name)}@liatrio.com`,
      display_name: r.email ? null : r.name,
      team_id: null,
      active: true,
    }))
  out.push({ id: "p-extra", email: "not.on.roster@liatrio.com", display_name: "Not On Roster", team_id: null, active: true })
  return out
}

type Row = Record<string, unknown>

/** set_cursor_seat_assignments / set_cursor_seat_rate as 026 implements them. */
function emulateWrites(db: FakeSupabase) {
  db.rpcHandlers.set_cursor_seat_assignments = (args) => {
    const from = String(args!.p_from_month)
    const rows = args!.p_rows as { person_id: string; seat_type: string }[]
    const ids = new Set(rows.map((r) => r.person_id))
    const t = db.table("cursor_seat_assignments")
    const kept = t.filter((a) => !(ids.has(a.person_id as string) && (a.effective_month as string) >= from))
    db.tables.cursor_seat_assignments = [
      ...kept,
      ...rows.map((r) => ({ person_id: r.person_id, effective_month: from, seat_type: r.seat_type, source: args!.p_source, set_by: args!.p_set_by })),
    ]
    return { data: rows.length, error: null }
  }
  db.rpcHandlers.set_cursor_seat_rate = (args) => {
    const from = String(args!.p_from_month)
    const type = String(args!.p_seat_type)
    const t = db.table("cursor_seat_rates").filter((r) => !(r.seat_type === type && (r.effective_month as string) >= from))
    db.tables.cursor_seat_rates = [...t, { seat_type: type, effective_month: from, monthly_rate_usd: String(args!.p_rate), updated_by: args!.p_set_by }]
    return { data: null, error: null }
  }
}

function seed() {
  const db = new FakeSupabase({
    providers: [{ id: CURSOR, name: "cursor", display_name: "Cursor" }],
    people: people(),
    recurring_costs: [],
    cursor_seat_assignments: [],
    cursor_seat_rates: [
      { seat_type: "standard", effective_month: "2000-01-01", monthly_rate_usd: "40.00" },
      { seat_type: "premium", effective_month: "2000-01-01", monthly_rate_usd: "80.00" },
      { seat_type: "free", effective_month: "2000-01-01", monthly_rate_usd: "0.00" },
    ],
  })
  emulateWrites(db)
  return db
}

type Handler = (req: NextRequest) => Promise<Response>
async function call(handler: unknown, method: string, path: string, body?: unknown) {
  const req = new NextRequest(new URL(path, "http://localhost"), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  })
  const res = await (handler as Handler)(req)
  return { status: res.status, body: await res.json() }
}
const BASE = "/api/admin/org/cursor-seats"
const getState = () => call(stateRoute.GET, "GET", BASE)
const assign = (body: unknown) => call(assignRoute.POST, "POST", `${BASE}/assign`, body)
const setRate = (body: unknown) => call(ratesRoute.POST, "POST", `${BASE}/rates`, body)
const runImport = (body: unknown) => call(importRoute.POST, "POST", `${BASE}/import`, body)

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
  jest.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z"), doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout", "clearTimeout"] })
})
afterAll(() => {
  process.env = savedEnv
  jest.useRealTimers()
})
beforeEach(() => {
  mockState.db = seed()
  mockAuth.user = ADMIN
})

const personByName = (name: string) => {
  const p = (mockState.db.table("people") as Row[]).find((x) => x.display_name === name)
  return p!.id as string
}
const personByEmail = (email: string) => (mockState.db.table("people") as Row[]).find((x) => x.email === email.toUpperCase())!.id as string

describe("auth", () => {
  it("every route is admin-only", async () => {
    for (const user of [null, OUTSIDER]) {
      mockAuth.user = user
      const expected = user ? 403 : 401
      expect((await getState()).status).toBe(expected)
      expect((await assign({ person_id: "p1", seat_type: "premium" })).status).toBe(expected)
      expect((await setRate({ seat_type: "premium", monthly_rate_usd: 1 })).status).toBe(expected)
      expect((await runImport({ csv: ROSTER_CSV, confirm: true })).status).toBe(expected)
    }
    expect(mockState.db.rpcCalls).toEqual([])
  })
})

describe("backfill from the Nov 5 roster assigns seat types by email (and name when email blank)", () => {
  it("previews without writing, then applies: 74 Standard + 36 Premium + 1 Free = $5,840, unmatched reported", async () => {
    const preview = await runImport({ csv: ROSTER_CSV })
    expect(preview.status).toBe(200)
    expect(preview.body.applied).toBe(0)
    expect(mockState.db.rpcCalls).toEqual([])
    expect(preview.body.roster).toEqual({ counts: { standard: 74, premium: 36, free: 1, none: 1 }, total_usd: 5840 })
    expect(preview.body.plan.unmatched).toEqual([{ line: 38, name: "Yujie Wu", email: "", seat_type: "Premium", reason: "name_not_found" }])
    expect(preview.body.plan.counts).toEqual({ standard: 74, premium: 35, free: 1, none: 1 })
    expect(preview.body.matched_total_usd).toBe(5760)

    const applied = await runImport({ csv: ROSTER_CSV, confirm: true })
    expect(applied.status).toBe(200)
    expect(applied.body.applied).toBe(111)
    expect(mockState.db.rpcLog).toEqual([
      expect.objectContaining({ name: "set_cursor_seat_assignments", args: expect.objectContaining({ p_from_month: "2026-11-01", p_source: "roster", p_set_by: ADMIN.email }) }),
    ])
    const state = applied.body.state
    expect(state.summary).toMatchObject({ month: "2026-11", total_usd: 5760, counts: { standard: 74, premium: 35, free: 1 } })
    // Issue #82: on Nov 5 edits apply from the Nov 20 – Dec 20 cycle (billed in November); Oct 20 – Nov 20 is in progress and untouched.
    expect(state.cycle).toEqual({ key: "2026-11", start: "2026-11-20", end: "2026-12-20", label: "Nov 20 – Dec 20, 2026" })
    expect(state.cycleInProgress).toMatchObject({ key: "2026-10", label: "Oct 20 – Nov 20, 2026" })
    expect(state.summary.cycle.label).toBe("Nov 20 – Dec 20, 2026")
    // Matched by email (stored upper-case) and by exact name.
    expect(state.current[personByEmail("robert@liatrio.com")]).toBe("premium")
    expect(state.current[personByEmail("drew.khoury@liatrio.com")]).toBe("standard")
    expect(state.current[personByName("Andrew Noble")]).toBe("premium")
    expect(state.current[personByName("William Bedford")]).toBe("free")
    expect(state.current[personByName("Daniel Helbling")]).toBe("none") // Removed: no billed seat
    expect(state.current["p-extra"]).toBe("none") // not on the roster: untouched, no person invented
    expect((mockState.db.table("people") as Row[]).length).toBe(people().length)

    // Yujie Wu is added to the org later and assigned by hand: the full roster is then $5,840.
    mockState.db.table("people").push({ id: "p-yujie", email: "yujie.wu@liatrio.com", display_name: "Yujie Wu", team_id: null, active: true })
    const r = await assign({ person_id: "p-yujie", seat_type: "premium" })
    expect(r.status).toBe(200)
    expect(r.body.summary.total_usd).toBe(5840)
    expect(r.body.summary.counts).toMatchObject({ standard: 74, premium: 36, free: 1 })
  })

  it("assignments stay editable after the backfill", async () => {
    await runImport({ csv: ROSTER_CSV, confirm: true })
    const bedford = personByName("William Bedford")
    const r = await assign({ person_ids: [bedford], seat_type: "standard" })
    expect(r.status).toBe(200)
    expect(r.body.current[bedford]).toBe("standard")
    expect(r.body.summary.total_usd).toBe(5760 + 40)
  })

  it("rejects a bad CSV and a past month", async () => {
    expect((await runImport({ csv: "" })).status).toBe(400)
    expect((await runImport({ csv: "a,b\n1,2\n" })).body.error).toMatch(/name and seat_type/)
    expect((await runImport({ csv: ROSTER_CSV, from_month: "2026-10", confirm: true })).status).toBe(400)
    expect(mockState.db.rpcCalls).toEqual([])
  })
})

describe("changing a person's seat type updates their attributed seat cost", () => {
  it("sets the type from the current month and returns the new summary", async () => {
    const id = personByName("Andrew Noble")
    let r = await assign({ person_id: id, seat_type: "premium" })
    expect(r.body.summary.total_usd).toBe(80)
    r = await assign({ person_id: id, seat_type: "standard" })
    expect(r.body.current[id]).toBe("standard")
    expect(r.body.summary.total_usd).toBe(40)
    r = await assign({ person_id: id, seat_type: "none" })
    expect(r.body.summary.total_usd).toBe(0)
    expect(mockState.db.rpcLog.map((c) => c.args!.p_from_month)).toEqual(["2026-11-01", "2026-11-01", "2026-11-01"])
  })

  it("refuses unknown people, unknown types and past months", async () => {
    expect((await assign({ person_id: "nope", seat_type: "premium" })).status).toBe(400)
    expect((await assign({ person_id: "p1", seat_type: "enterprise" })).status).toBe(400)
    expect((await assign({ person_id: "p1", seat_type: "premium", from_month: "2026-10" })).status).toBe(400)
    expect(mockState.db.rpcCalls).toEqual([])
  })
})

describe("rates are configurable in admin", () => {
  it("defaults are Standard $40 / Premium $80 / Free $0; an edit changes the rate from this month with no code change", async () => {
    expect((await getState()).body.rates).toEqual({ standard: 40, premium: 80, free: 0 })
    await assign({ person_ids: [personByName("Andrew Noble")], seat_type: "premium" })
    const r = await setRate({ seat_type: "premium", monthly_rate_usd: "95" })
    expect(r.status).toBe(200)
    expect(r.body.rates).toEqual({ standard: 40, premium: 95, free: 0 })
    expect(r.body.summary.total_usd).toBe(95)
    expect(mockState.db.rpcLog.at(-1)).toEqual({
      name: "set_cursor_seat_rate",
      args: { p_seat_type: "premium", p_from_month: "2026-11-01", p_rate: 95, p_set_by: ADMIN.email },
    })
  })

  it("refuses bad rates and past months", async () => {
    expect((await setRate({ seat_type: "premium", monthly_rate_usd: -5 })).status).toBe(400)
    expect((await setRate({ seat_type: "none", monthly_rate_usd: 5 })).status).toBe(400)
    expect((await setRate({ seat_type: "premium", monthly_rate_usd: 5, from_month: "2026-09" })).status).toBe(400)
    expect(mockState.db.rpcCalls).toEqual([])
  })
})

describe("no double-count with a recurring Cursor seat line", () => {
  it("flags a recurring Cursor cost covering this month", async () => {
    expect((await getState()).body.recurringConflict).toBe(false)
    mockState.db.table("recurring_costs").push({ id: "rc1", provider_id: CURSOR, start_month: "2026-09-01", end_month: null, monthly_cost_usd: "5840.00", seats: null, price_per_seat: null })
    expect((await getState()).body.recurringConflict).toBe(true)
  })
})

describe("safe without migration 026 (missing-table fallback)", () => {
  beforeEach(() => {
    mockState.db.missingTables.add("cursor_seat_assignments")
    mockState.db.missingTables.add("cursor_seat_rates")
  })

  it("GET shows the notice and nothing assigned", async () => {
    const r = await getState()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ available: false, current: {}, summary: null, assignmentCount: 0 })
    expect(r.body.notice).toMatch(/migration 026/)
  })

  it("writes answer 503 with the notice", async () => {
    mockState.db.rpcHandlers.set_cursor_seat_assignments = () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.set_cursor_seat_assignments" },
    })
    const r = await assign({ person_id: "p1", seat_type: "premium" })
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/migration 026/)
    const imp = await runImport({ csv: ROSTER_CSV })
    expect(imp.status).toBe(503)
  })
})
