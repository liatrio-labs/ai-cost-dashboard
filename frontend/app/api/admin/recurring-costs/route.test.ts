/**
 * @jest-environment node
 *
 * /api/admin/recurring-costs and the `recurring` option of POST
 * /api/admin/providers (issue #59). The real requireAdmin runs against a
 * mocked Supabase auth client; the service-role client is the in-memory fake,
 * with an rpc() that does what set_recurring_cost() (migration 022) does.
 * No network, no database.
 */

import { NextRequest } from "next/server"
import { FakeSupabase } from "@/lib/org/admin/testing/fake-supabase"

const mockAuth = { user: null as null | { id: string; email: string } }
const mockState = { db: null as unknown as RecurringFake, refreshes: 0 }

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

import * as recurring from "./route"
import * as providers from "@/app/api/admin/providers/route"

type Row = Record<string, unknown>
const MISSING = { code: "PGRST202", message: "Could not find the function public.set_recurring_cost in the schema cache" }

const addMonth = (d: string, n: number) => {
  const [y, m] = d.split("-").map(Number)
  const x = new Date(Date.UTC(y, m - 1 + n, 1))
  return x.toISOString().slice(0, 10)
}

/** FakeSupabase plus set_recurring_cost(), mirroring the SQL function. */
class RecurringFake extends FakeSupabase {
  rpcArgs: Row[] = []
  migrated = true
  async rpc(name: string, args?: Row) {
    this.rpcCalls.push(name)
    if (name !== "set_recurring_cost") return { data: null, error: null }
    if (!this.migrated) return { data: null, error: MISSING }
    this.rpcArgs.push(args ?? {})
    const pid = args!.p_provider_id as string
    const from = args!.p_from_month as string
    const t = this.table("recurring_costs")
    for (const r of t.filter((r) => r.provider_id === pid && (r.start_month as string) >= from)) t.splice(t.indexOf(r), 1)
    for (const r of t) {
      if (r.provider_id === pid && (r.start_month as string) < from && (!r.end_month || (r.end_month as string) >= from)) r.end_month = addMonth(from, -1)
    }
    if (args!.p_monthly_cost_usd === null) return { data: null, error: null }
    const id = this.nextId("recurring_costs")
    t.push({
      id,
      provider_id: pid,
      start_month: from,
      end_month: args!.p_end_month,
      monthly_cost_usd: Number(args!.p_monthly_cost_usd).toFixed(2),
      seats: args!.p_seats,
      price_per_seat: args!.p_price_per_seat,
      notes: args!.p_notes,
    })
    return { data: id, error: null }
  }
  from(table: string) {
    if (table === "recurring_costs" && !this.migrated) {
      const err = { code: "PGRST205", message: "Could not find the table 'public.recurring_costs' in the schema cache" }
      const q = { select: () => q, order: () => q, then: (resolve: (v: unknown) => void) => resolve({ data: null, error: err }) }
      return q as unknown as ReturnType<FakeSupabase["from"]>
    }
    return super.from(table)
  }
}

const LOVABLE = "prov-lovable"
const ADMIN = { id: "u-admin", email: "admin@example.com" }
const OUTSIDER = { id: "u-out", email: "someone@elsewhere.test" }

function seed() {
  return new RecurringFake({
    providers: [{ id: LOVABLE, name: "lovable", display_name: "Lovable", is_active: true, metadata: { collection_method: "manual" } }],
    cost_records: [{ id: "cr1", provider_id: LOVABLE, cost_usd: 80, collection_method: "manual_entry", metadata: { month: "2026-03" } }],
  })
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
const get = () => call(() => recurring.GET(), "GET", "/api/admin/recurring-costs")
const post = (body: unknown) => call(recurring.POST, "POST", "/api/admin/recurring-costs", body)
const segments = () =>
  mockState.db
    .table("recurring_costs")
    .map((r) => `${r.start_month}..${r.end_month ?? "open"}:${r.monthly_cost_usd}`)
    .sort()

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

describe("auth", () => {
  it("GET and POST are admin-only", async () => {
    for (const user of [null, OUTSIDER]) {
      mockAuth.user = user
      const expected = user ? 403 : 401
      expect((await get()).status).toBe(expected)
      expect((await post({ provider_id: LOVABLE, from_month: "2026-11", monthly_cost_usd: 1 })).status).toBe(expected)
      expect((await call(providers.POST, "POST", "/api/admin/providers", { display_name: "X", recurring: { from_month: "2026-11", monthly_cost_usd: 1 } })).status).toBe(expected)
    }
    expect(mockState.db.rpcCalls).toEqual([])
    expect(mockState.db.table("providers")).toHaveLength(1)
  })
})

describe("POST /api/admin/recurring-costs", () => {
  it("sets, changes from a month and ends; earlier months stay; cost_records untouched", async () => {
    const before = JSON.stringify(mockState.db.table("cost_records"))
    let res = await post({ provider_id: LOVABLE, from_month: "2026-06", monthly_cost_usd: 100, notes: "team plan" })
    expect(res.status).toBe(200)
    expect(mockState.db.rpcArgs[0]).toEqual({
      p_provider_id: LOVABLE,
      p_from_month: "2026-06-01",
      p_monthly_cost_usd: 100,
      p_seats: null,
      p_price_per_seat: null,
      p_end_month: null,
      p_notes: "team plan",
      p_created_by: ADMIN.id,
    })
    res = await post({ provider_id: LOVABLE, from_month: "2026-09", seats: 5, price_per_seat: 25 })
    expect(res.body.costs).toHaveLength(2)
    expect(segments()).toEqual(["2026-06-01..2026-08-01:100.00", "2026-09-01..open:125.00"])
    res = await post({ provider_id: LOVABLE, from_month: "2026-12", end: true })
    expect(res.status).toBe(200)
    expect(segments()).toEqual(["2026-06-01..2026-08-01:100.00", "2026-09-01..2026-11-01:125.00"])
    expect(JSON.stringify(mockState.db.table("cost_records"))).toBe(before)
    expect(mockState.refreshes).toBe(0)
  })

  it.each([
    [{ provider_id: LOVABLE, from_month: "2026-6", monthly_cost_usd: 1 }, 400],
    [{ provider_id: LOVABLE, from_month: "2026-06" }, 400],
    [{ provider_id: LOVABLE, from_month: "2026-06", seats: 0, price_per_seat: 1 }, 400],
    [{ provider_id: "nope", from_month: "2026-06", monthly_cost_usd: 1 }, 404],
  ])("rejects %j with %i", async (body, status) => {
    expect((await post(body)).status).toBe(status)
    expect(mockState.db.rpcCalls).toEqual([])
  })

  it("GET lists segments", async () => {
    await post({ provider_id: LOVABLE, from_month: "2026-06", monthly_cost_usd: 100 })
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.available).toBe(true)
    expect(body.costs).toHaveLength(1)
    expect(body.currentMonth).toMatch(/^\d{4}-\d{2}$/)
  })
})

describe("without migration 022", () => {
  beforeEach(() => {
    mockState.db.migrated = false
  })
  it("GET says unavailable instead of failing", async () => {
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body).toMatchObject({ available: false, costs: [] })
  })
  it("POST answers 503 with an explanation", async () => {
    const { status, body } = await post({ provider_id: LOVABLE, from_month: "2026-06", monthly_cost_usd: 100 })
    expect(status).toBe(503)
    expect(body.error).toMatch(/migration 022/)
  })
  it("creating a tool with a recurring cost still creates the tool and says the cost wasn't saved", async () => {
    const { status, body } = await call(providers.POST, "POST", "/api/admin/providers", {
      display_name: "Claude Ultra Two",
      recurring: { from_month: "2026-11", seats: 3, price_per_seat: 200 },
    })
    expect(status).toBe(201)
    expect(body.recurring_saved).toBe(false)
    expect(body.message).toMatch(/migration 022/)
    expect(mockState.db.table("providers")).toHaveLength(2)
  })
})

describe("POST /api/admin/providers with a recurring cost", () => {
  it("creates the tool and its recurring cost from the start month", async () => {
    const { status, body } = await call(providers.POST, "POST", "/api/admin/providers", {
      display_name: "ChatGPT Business",
      seat_based: true,
      recurring: { from_month: "2026-11", seats: 12, price_per_seat: 30 },
    })
    expect(status).toBe(201)
    expect(body.recurring_saved).toBe(true)
    const created = mockState.db.table("providers").find((p) => p.name === "chatgpt-business")!
    expect(created.metadata).toMatchObject({ collection_method: "manual", billing: "seat" })
    expect(mockState.db.rpcArgs).toEqual([
      expect.objectContaining({ p_provider_id: created.id, p_from_month: "2026-11-01", p_monthly_cost_usd: 360, p_seats: 12, p_price_per_seat: 30 }),
    ])
  })

  it("rejects a bad recurring cost before creating anything", async () => {
    const { status } = await call(providers.POST, "POST", "/api/admin/providers", {
      display_name: "Lovable Two",
      recurring: { from_month: "next month", monthly_cost_usd: 10 },
    })
    expect(status).toBe(400)
    expect(mockState.db.table("providers")).toHaveLength(1)
    expect(mockState.db.rpcCalls).toEqual([])
  })

  it("without `recurring` behaves as before", async () => {
    const { status, body } = await call(providers.POST, "POST", "/api/admin/providers", { display_name: "Plain Tool" })
    expect(status).toBe(201)
    expect(body.message).toBe("Tool created")
    expect(body.recurring_saved).toBeUndefined()
    expect(mockState.db.rpcCalls).toEqual([])
  })
})
