/**
 * @jest-environment node
 *
 * /api/admin/coverage (#21) against the in-memory admin fake.
 */

import { NextRequest } from "next/server"
import { FakeSupabase } from "@/lib/org/admin/testing/fake-supabase"

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
jest.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockState.db }))

import { GET } from "./route"

const ADMIN = { id: "u-admin", email: "admin@example.com" }
const NOW = new Date("2026-11-03T15:30:00Z")

function day(offset: number): string {
  return new Date(Date.UTC(2026, 10, 3) - offset * 86400000).toISOString().slice(0, 10)
}

/** 30 days of history for two providers; anthropic is missing 10-30 and openai is short on 11-01. */
function seed() {
  const daily: object[] = []
  for (let i = 1; i <= 30; i++) {
    const date = day(i)
    if (date !== "2026-10-30") {
      // Two models per day: the route must sum them.
      daily.push({ user_id: "owner", provider_id: "p-anth", date, model_name: "a", total_cost_usd: "60" })
      daily.push({ user_id: "owner", provider_id: "p-anth", date, model_name: "b", total_cost_usd: 40 })
    }
    daily.push({ user_id: "owner", provider_id: "p-oai", date, model_name: "gpt", total_cost_usd: date === "2026-11-01" ? 1 : 20 })
    daily.push({ user_id: "owner", provider_id: "p-ws", date, model_name: "windsurf", total_cost_usd: 0 })
  }
  return new FakeSupabase({
    providers: [
      { id: "p-anth", name: "anthropic" },
      { id: "p-oai", name: "openai" },
      { id: "p-ws", name: "windsurf" },
    ],
    cost_records_daily: daily,
  })
}

async function call(query = "") {
  const req = new NextRequest(new URL(`/api/admin/coverage${query}`, "http://localhost"))
  const res = await GET(req, { params: Promise.resolve({}) })
  return { status: res.status, body: await res.json() }
}

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
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

describe("GET /api/admin/coverage", () => {
  test("requires an admin", async () => {
    mockAuth.user = null
    expect((await call()).status).toBe(401)
    mockAuth.user = { id: "u2", email: "someone@elsewhere.org" }
    expect((await call()).status).toBe(403)
  })

  test("flags missing and short days across providers, ignoring zero-spend providers", async () => {
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.window).toEqual({ start: "2026-10-27", end: "2026-11-02", days: 7 })
    expect(body.trailingWindow).toBe(14)
    expect(body.fraction).toBe(0.25)
    expect(body.gaps).toEqual([
      { provider: "anthropic", date: "2026-10-30", reason: "missing", total: null, median: 100, threshold: 25 },
      { provider: "openai", date: "2026-11-01", reason: "low", total: 1, median: 20, threshold: 5 },
    ])
  })

  test("filters by provider and honours days", async () => {
    const { body } = await call("?provider=openai&days=2")
    expect(body.window).toEqual({ start: "2026-11-01", end: "2026-11-02", days: 2 })
    expect(body.gaps.map((g: { provider: string; date: string }) => `${g.provider}:${g.date}`)).toEqual(["openai:2026-11-01"])
    expect((await call("?provider=anthropic&days=3")).body.gaps).toEqual([])
  })

  test("validates params", async () => {
    expect((await call("?days=0")).status).toBe(400)
    expect((await call("?days=91")).status).toBe(400)
    expect((await call("?days=abc")).status).toBe(400)
    expect((await call("?provider=nope")).status).toBe(400)
  })
})
