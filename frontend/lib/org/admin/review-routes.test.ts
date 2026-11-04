/**
 * @jest-environment node
 *
 * /api/admin/org/review (issue #44): Acknowledge persists with a note and the
 * item is hidden on the next GET (migration 018 applied); without 018 GET
 * still lists items with a "migration 018 not applied" notice and POST is a
 * 409, never a 500. Mocked auth, in-memory Supabase fake; no network.
 */

import { NextRequest } from "next/server"
import { FakeSupabase } from "./testing/fake-supabase"

const mockAuth = { user: null as null | { id: string; email: string } }
const mockState = { db: null as unknown }

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

import * as review from "@/app/api/admin/org/review/route"

const ADMIN = { id: "u-admin", email: "admin@example.com" }
const AN = "prov-an"
const TEAM = "team-a"

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
async function call(handler: unknown, method: string, body?: unknown) {
  const req = new NextRequest(new URL("/api/admin/org/review", "http://localhost"), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  })
  const res = await (handler as Handler)(req, { params: Promise.resolve({}) })
  return { status: res.status, body: await res.json() }
}

const row = (date: string, person_id: string, cost: number) => ({
  date,
  provider_id: AN,
  model_name: "m",
  person_id,
  org_api_key_id: null,
  team_id: TEAM,
  department_id: null,
  project_id: null,
  workspace_id: null,
  granularity: "person",
  total_cost_usd: cost,
  total_tokens: 0,
  total_requests: 0,
  record_count: 1,
})

function seed() {
  return new FakeSupabase({
    departments: [],
    teams: [{ id: TEAM, name: "A", department_id: null }],
    people: [
      { id: "p600", email: "p600@liatrio.com", display_name: "Six Hundred", team_id: TEAM, active: true },
      { id: "pday", email: "pday@liatrio.com", display_name: "Day", team_id: TEAM, active: true },
    ],
    person_identities: [],
    org_api_keys: [],
    org_projects: [],
    providers: [{ id: AN, name: "anthropic", display_name: "Anthropic", last_collected_at: "2026-11-15T06:00:00Z", documentation_url: null, metadata: null }],
    cost_records_daily_attributed: [
      row("2026-09-10", "p600", 285.71),
      row("2026-10-10", "p600", 200),
      row("2026-10-11", "p600", 200),
      row("2026-10-12", "p600", 200),
      row("2026-10-05", "pday", 290),
      row("2026-10-06", "pday", 290),
      row("2026-11-03", "pday", 301),
    ],
    review_items: [],
  })
}

/** The fake as a database without migration 018: review_items doesn't exist. */
function without018(db: FakeSupabase) {
  const missing = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.review_items' in the schema cache" } }
  const chain: Record<string, unknown> = {}
  for (const m of ["select", "insert", "update", "eq", "single", "order", "range"]) chain[m] = () => chain
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(missing).then(ok)
  return { from: (t: string) => (t === "review_items" ? chain : db.from(t)), rpc: db.rpc.bind(db) }
}

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
  jest.useFakeTimers({ now: new Date("2026-11-15T12:00:00Z"), doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "clearImmediate"] })
})
afterAll(() => {
  process.env = savedEnv
  jest.useRealTimers()
})
beforeEach(() => {
  mockAuth.user = ADMIN
})

const spike = { kind: "person_spike", subject: "p600", period: "2026-10" }

describe("with migration 018", () => {
  test("Acknowledge persists with its note and the item is hidden after refresh", async () => {
    const db = seed()
    mockState.db = db
    const first = await call(review.GET, "GET")
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ decisions_available: true, notice: null, hiddenCount: 0 })
    const item = first.body.items.find((i: { id: string }) => i.id === "person_spike|p600|2026-10")
    expect(item).toMatchObject({ amount: 600, ratio: 2.1, label: "Six Hundred" })
    expect(first.body.items.find((i: { id: string }) => i.id === "person_day|pday|2026-11-03")).toBeDefined()

    const ack = await call(review.POST, "POST", { ...spike, amount: item.amount, note: "  offsite demo  " })
    expect(ack.status).toBe(201)
    expect(ack.body).toMatchObject({ ...spike, status: "acknowledged", note: "offsite demo", acknowledged_by: ADMIN.email })
    expect(db.table("review_items")).toHaveLength(1)

    const after = await call(review.GET, "GET")
    expect(after.body.items.find((i: { id: string }) => i.id === "person_spike|p600|2026-10")).toBeUndefined()
    expect(after.body.hiddenCount).toBe(1)

    // Acknowledging again replaces the decision (one row per item).
    await call(review.POST, "POST", { ...spike, amount: 600, status: "assigned", note: "" })
    expect(db.table("review_items")).toHaveLength(1)
    expect(db.table("review_items")[0]).toMatchObject({ status: "assigned", note: null })
  })

  test("the item comes back once its amount grows more than 25%", async () => {
    const db = seed()
    mockState.db = db
    await call(review.POST, "POST", { ...spike, amount: 400 })
    const res = await call(review.GET, "GET")
    expect(res.body.items.find((i: { id: string }) => i.id === "person_spike|p600|2026-10")).toMatchObject({ previous: { amount: 400 } })
  })

  test("invalid bodies are 400s", async () => {
    mockState.db = seed()
    expect((await call(review.POST, "POST", { ...spike, kind: "nope", amount: 1 })).status).toBe(400)
    expect((await call(review.POST, "POST", { ...spike, period: "Oct", amount: 1 })).status).toBe(400)
    expect((await call(review.POST, "POST", { ...spike, amount: -1 })).status).toBe(400)
  })

  test("admins only", async () => {
    mockState.db = seed()
    mockAuth.user = null
    expect((await call(review.GET, "GET")).status).toBe(401)
    mockAuth.user = { id: "u-x", email: "someone@elsewhere.test" }
    expect((await call(review.POST, "POST", { ...spike, amount: 1 })).status).toBe(403)
  })
})

describe("without migration 018", () => {
  test("GET lists items live with a clear notice; POST is a 409, not a 500", async () => {
    mockState.db = without018(seed())
    const res = await call(review.GET, "GET")
    expect(res.status).toBe(200)
    expect(res.body.decisions_available).toBe(false)
    expect(res.body.notice).toMatch(/migration 018 not applied/i)
    expect(res.body.items.map((i: { id: string }) => i.id)).toContain("person_spike|p600|2026-10")

    const ack = await call(review.POST, "POST", { ...spike, amount: 600, note: "x" })
    expect(ack.status).toBe(409)
    expect(ack.body).toMatchObject({ code: "migration_018_not_applied" })
    expect(ack.body.error).toMatch(/migration 018 not applied/i)
  })
})
