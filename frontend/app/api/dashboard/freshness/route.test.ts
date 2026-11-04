/**
 * @jest-environment node
 *
 * /api/dashboard/freshness is admin only (#57): 401 logged out, 403 for
 * non-admins, 200 with the same payload for admins.
 */

import { FakeSupabase } from "@/lib/org/admin/testing/fake-supabase"

const mockAuth = { user: null as null | { id: string; email: string } }
const mockState = { db: null as unknown as FakeSupabase }

jest.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}))
jest.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: mockAuth.user }, error: null }) },
    from: (table: string) => mockState.db.from(table),
  }),
}))

import { GET } from "./route"

const ADMIN = { id: "u-admin", email: "admin@example.com" }
const NOW = new Date("2026-11-10T15:30:00Z")

function seed() {
  return new FakeSupabase({
    providers: [
      { id: "p-anth", name: "anthropic", display_name: "Anthropic", last_collected_at: "2026-11-10T14:00:00Z", metadata: {}, is_active: true },
      { id: "p-gpt", name: "chatgpt", display_name: "ChatGPT", last_collected_at: null, metadata: { collection_method: "manual" }, is_active: true },
      { id: "p-old", name: "retired", display_name: "Retired", last_collected_at: null, metadata: {}, is_active: false },
    ],
    cost_records_daily: [],
  })
}

async function call() {
  const res = await GET()
  return { status: res.status, body: await res.json() }
}

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.supabase.co"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "placeholder-anon-key"
  jest.useFakeTimers({ now: NOW, doNotFake: ["setTimeout", "clearTimeout", "setImmediate", "nextTick", "queueMicrotask"] })
})
afterAll(() => {
  process.env = savedEnv
  jest.useRealTimers()
})
beforeEach(() => {
  mockAuth.user = ADMIN
  mockState.db = seed()
})

describe("GET /api/dashboard/freshness", () => {
  test("401 when logged out", async () => {
    mockAuth.user = null
    const { status, body } = await call()
    expect(status).toBe(401)
    expect(body.error).toBe("Unauthorized")
  })

  test("403 for a logged-in non-admin", async () => {
    mockAuth.user = { id: "u2", email: "someone@elsewhere.org" }
    const { status, body } = await call()
    expect(status).toBe(403)
    expect(body.error).toBe("Forbidden")
    expect(body.providers).toBeUndefined()
  })

  test("200 with per-provider freshness for an admin", async () => {
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.asOf).toBe(NOW.toISOString())
    const byId = Object.fromEntries(body.providers.map((p: { id: string }) => [p.id, p]))
    expect(Object.keys(byId).sort()).toEqual(["p-anth", "p-gpt"])
    expect(byId["p-gpt"].state).toBe("manual_missing")
    expect(byId["p-gpt"].warning).toBe(true)
    expect(byId["p-anth"].lastSyncedAt).toBe("2026-11-10T14:00:00.000Z")
  })

  // Issue #59
  test("a manual provider covered by a recurring cost this month has no 'no entry' warning", async () => {
    mockState.db.table("recurring_costs").push({
      id: "rc1", provider_id: "p-gpt", start_month: "2026-09-01", end_month: null, monthly_cost_usd: "600.00", seats: null, price_per_seat: null,
    })
    const { status, body } = await call()
    expect(status).toBe(200)
    const gpt = body.providers.find((p: { id: string }) => p.id === "p-gpt")
    expect(gpt.state).toBe("manual_ok")
    expect(gpt.warning).toBe(false)
  })

  test("a recurring cost that ended last month doesn't suppress the warning", async () => {
    mockState.db.table("recurring_costs").push({
      id: "rc1", provider_id: "p-gpt", start_month: "2026-01-01", end_month: "2026-10-01", monthly_cost_usd: "600.00", seats: null, price_per_seat: null,
    })
    const { body } = await call()
    expect(body.providers.find((p: { id: string }) => p.id === "p-gpt").state).toBe("manual_missing")
  })

  test("without migration 022 the warning is as before (no error)", async () => {
    const db = mockState.db
    const from = db.from.bind(db)
    db.from = ((table: string) =>
      table === "recurring_costs"
        ? { select: () => ({ order: async () => ({ data: null, error: { code: "42P01", message: 'relation "public.recurring_costs" does not exist' } }) }) }
        : from(table)) as typeof db.from
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.providers.find((p: { id: string }) => p.id === "p-gpt").state).toBe("manual_missing")
  })
})
