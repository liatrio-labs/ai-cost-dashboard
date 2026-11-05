/**
 * @jest-environment node
 *
 * /api/admin/invoice-overrides (issue #75). The real requireAdmin runs
 * against a mocked Supabase auth client; the service-role client is the
 * in-memory fake. No network, no database.
 */

import { NextRequest } from "next/server"
import { FakeSupabase, ORG_TABLE_CONFIG } from "@/lib/org/admin/testing/fake-supabase"

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

import * as route from "./route"

const CURSOR = "prov-cursor"
const LOVABLE = "prov-lovable"
const ADMIN = { id: "u-admin", email: "admin@example.com" }
const OUTSIDER = { id: "u-out", email: "someone@elsewhere.test" }

function seed() {
  return new FakeSupabase(
    {
      providers: [
        { id: CURSOR, name: "cursor", display_name: "Cursor" },
        { id: LOVABLE, name: "lovable", display_name: "Lovable" },
      ],
      cost_records_daily: [
        { date: "2026-09-03", provider_id: CURSOR, model_name: "auto", total_cost_usd: 900 },
        { date: "2026-09-01", provider_id: CURSOR, model_name: "manual", total_cost_usd: 100 },
        { date: "2026-10-03", provider_id: CURSOR, model_name: "auto", total_cost_usd: 5000 },
      ],
      cost_records: [
        { id: "cr1", user_id: "u1", provider_id: CURSOR, timestamp: "2026-09-01T12:00:00Z", model_name: "manual", cost_usd: 100, request_count: 1, collection_method: "manual_entry", metadata: { month: "2026-09" } },
      ],
      recurring_costs: [
        { id: "rc1", provider_id: LOVABLE, start_month: "2026-08-01", end_month: null, monthly_cost_usd: "90.00", seats: null, price_per_seat: null, notes: null },
      ],
      invoice_overrides: [],
    },
    { ...ORG_TABLE_CONFIG, invoice_overrides: { unique: [{ columns: ["provider_id", "month"] }] } }
  )
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
const BASE = "/api/admin/invoice-overrides"
const get = (qs = "") => call(route.GET, "GET", `${BASE}${qs}`)
const post = (body: unknown) => call(route.POST, "POST", BASE, body)
const del = (qs: string) => call(route.DELETE, "DELETE", `${BASE}${qs}`)

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

describe("auth", () => {
  it("GET, POST and DELETE are admin-only (requireAdmin)", async () => {
    for (const user of [null, OUTSIDER]) {
      mockAuth.user = user
      const expected = user ? 403 : 401
      expect((await get()).status).toBe(expected)
      expect((await post({ provider_id: CURSOR, month: "2026-09", billed_amount_usd: 1 })).status).toBe(expected)
      expect((await del(`?provider_id=${CURSOR}&month=2026-09`)).status).toBe(expected)
    }
    expect(mockState.db.writes).toEqual([])
  })
})

describe("set and clear", () => {
  it("shows the API value next to the invoiced amount, replaces on a second set, and clears", async () => {
    const preview = await get(`?provider_id=${CURSOR}&month=2026-09`)
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ available: true, notice: null, currentMonth: "2026-11", overrides: [] })
    expect(preview.body.preview).toEqual({ provider_id: CURSOR, month: "2026-09", api_usd: 900, manual_usd: 100, recurring_usd: 0, without_override_usd: 1000 })

    const set = await post({ provider_id: CURSOR, month: "2026-09", billed_amount_usd: 250, credits_usd: 10, invoice_ids: "INV-1, INV-2", notes: "trial" })
    expect(set.status).toBe(200)
    expect(set.body.overrides).toHaveLength(1)
    expect(set.body.overrides[0]).toMatchObject({
      provider_id: CURSOR,
      month: "2026-09",
      api_usd: 900,
      without_override_usd: 1000,
      billed_amount_usd: 250,
      credits_usd: 10,
      delta_usd: -750,
      invoice_ids: ["INV-1", "INV-2"],
      notes: "trial",
      entered_by: ADMIN.email,
    })
    expect(mockState.db.table("invoice_overrides")[0]).toMatchObject({ month: "2026-09-01", billed_amount_usd: 250 })

    const replaced = await post({ provider_id: CURSOR, month: "2026-09", billed_amount_usd: 300 })
    expect(replaced.status).toBe(200)
    expect(mockState.db.table("invoice_overrides")).toHaveLength(1)
    expect(replaced.body.overrides[0]).toMatchObject({ billed_amount_usd: 300, credits_usd: null, invoice_ids: [] })

    // A recurring-only month shows the recurring amount it replaces.
    await post({ provider_id: LOVABLE, month: "2026-10", billed_amount_usd: 60 })
    const lov = (await get()).body.overrides.find((o: { provider_id: string }) => o.provider_id === LOVABLE)
    expect(lov).toMatchObject({ api_usd: 0, recurring_usd: 90, without_override_usd: 90, delta_usd: -30 })

    const cleared = await del(`?provider_id=${CURSOR}&month=2026-09`)
    expect(cleared.status).toBe(200)
    expect(cleared.body.overrides.map((o: { provider_id: string }) => o.provider_id)).toEqual([LOVABLE])
  })

  it("rejects bad input, the current month and unknown providers; never touches cost_records", async () => {
    expect((await post({ provider_id: CURSOR, month: "2026-11", billed_amount_usd: 1 })).status).toBe(400)
    expect((await post({ provider_id: CURSOR, month: "2026-09", billed_amount_usd: -1 })).status).toBe(400)
    expect((await post({ provider_id: "nope", month: "2026-09", billed_amount_usd: 1 })).status).toBe(404)
    expect((await del(`?provider_id=${CURSOR}&month=bad`)).status).toBe(400)
    expect((await get(`?provider_id=${CURSOR}&month=bad`)).status).toBe(400)
    expect(mockState.db.writes.filter((w) => w.table !== "invoice_overrides")).toEqual([])
  })
})

describe("missing-table fallback", () => {
  it("without migration 024: GET is a 200 with a notice, writes are 503s", async () => {
    mockState.db.missingTables.add("invoice_overrides")
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ available: false, overrides: [] })
    expect(res.body.notice).toMatch(/migration 024/)
    expect((await post({ provider_id: CURSOR, month: "2026-09", billed_amount_usd: 1 })).status).toBe(503)
    expect((await del(`?provider_id=${CURSOR}&month=2026-09`)).status).toBe(503)
  })
})
