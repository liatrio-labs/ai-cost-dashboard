/**
 * @jest-environment node
 *
 * POST /api/admin/collect auth + date-range handling (issue #20). The runner
 * and the admin session check are mocked; no network, no database.
 */

import { NextRequest } from "next/server"

const mockAuth = { admin: false }
const mockRun = jest.fn()
const mockRefresh = jest.fn()

jest.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}))
jest.mock("@/lib/db", () => {
  const { NextResponse } = jest.requireActual("next/server")
  return {
    requireAdmin: async () => {
      if (!mockAuth.admin) throw new Error("Unauthorized")
      return { id: "u-admin", email: "admin@example.com" }
    },
    errorResponse: (message: string, status = 500) => NextResponse.json({ error: message }, { status }),
    successResponse: (data: unknown, status = 200) => NextResponse.json(data, { status }),
  }
})
jest.mock("@/lib/collectors/runner", () => ({
  COLLECTORS: { anthropic: {}, "claude-ai": {}, openai: {}, cursor: {} },
  runCollectionForProvider: (...args: unknown[]) => mockRun(...args),
}))
jest.mock("@/lib/supabase/admin", () => ({
  refreshDailyAggregates: (...args: unknown[]) => mockRefresh(...args),
}))

import { POST } from "./route"

// Test-only placeholder, never a real secret.
const SECRET = "test-trigger-secret-value"

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/admin/collect", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("POST /api/admin/collect", () => {
  const saved = process.env.COLLECTION_TRIGGER_SECRET
  beforeEach(() => {
    mockAuth.admin = false
    process.env.COLLECTION_TRIGGER_SECRET = SECRET
    mockRun.mockReset().mockResolvedValue({ status: "success", provider: "anthropic", records_stored: 3, timestamp: "t" })
    mockRefresh.mockReset().mockResolvedValue(undefined)
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.COLLECTION_TRIGGER_SECRET
    else process.env.COLLECTION_TRIGGER_SECRET = saved
  })

  test("admin session works and keeps the backfill behaviour", async () => {
    mockAuth.admin = true
    const r = await POST(req({ provider: "anthropic", backfill: true, backfill_days: 30 }))
    expect(r.status).toBe(200)
    expect(mockRun).toHaveBeenCalledWith("anthropic", { backfill: true, backfillDays: 30 })
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  test("admin session without dates: default daily pull (unchanged)", async () => {
    mockAuth.admin = true
    await POST(req({ provider: "openai" }))
    expect(mockRun).toHaveBeenCalledWith("openai", { backfill: false, backfillDays: 90 })
  })

  test("correct bearer COLLECTION_TRIGGER_SECRET works without a session", async () => {
    const r = await POST(req({ provider: "anthropic" }, { authorization: `Bearer ${SECRET}` }))
    expect(r.status).toBe(200)
    expect(mockRun).toHaveBeenCalled()
  })

  test("wrong bearer -> 401, even with an admin session", async () => {
    mockAuth.admin = true
    const r = await POST(req({ provider: "anthropic" }, { authorization: "Bearer nope" }))
    expect(r.status).toBe(401)
    expect(mockRun).not.toHaveBeenCalled()
  })

  test("missing bearer and no session -> 401", async () => {
    const r = await POST(req({ provider: "anthropic" }))
    expect(r.status).toBe(401)
    expect(mockRun).not.toHaveBeenCalled()
  })

  test.each([[undefined], [""]])("env var %p -> bearer path disabled", async (value) => {
    if (value === undefined) delete process.env.COLLECTION_TRIGGER_SECRET
    else process.env.COLLECTION_TRIGGER_SECRET = value
    for (const auth of [`Bearer ${SECRET}`, "Bearer ", "Bearer undefined"]) {
      const r = await POST(req({ provider: "anthropic" }, { authorization: auth }))
      expect(r.status).toBe(401)
    }
    expect(mockRun).not.toHaveBeenCalled()
  })

  test("a valid range is passed to the runner as [start, end + 1 day) and echoed back", async () => {
    mockRun.mockResolvedValue({
      status: "success",
      provider: "anthropic",
      records_stored: 6,
      days: [{ date: "2026-01-24", records: 6, cost_usd: 10 }],
      timestamp: "t",
    })
    const r = await POST(
      req({ provider: "anthropic", start_date: "2025-12-25", end_date: "2026-01-24", backfill: true }, { authorization: `Bearer ${SECRET}` })
    )
    expect(r.status).toBe(200)
    const [provider, opts] = mockRun.mock.calls[0]
    expect(provider).toBe("anthropic")
    expect(opts).toEqual({ range: { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-25T00:00:00Z") } })
    const json = await r.json()
    expect(json.records_stored).toBe(6)
    expect(json.days).toHaveLength(1)
    expect(json.range).toEqual({
      start_date: "2026-01-01",
      end_date: "2026-01-24",
      requested_start_date: "2025-12-25",
      clamped: true,
    })
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  test.each([
    [{ provider: "anthropic", start_date: "2026-03-01" }, /together/],
    [{ provider: "anthropic", start_date: "2026-03-01", end_date: "2026-04-15" }, /maximum is 31/],
    [{ provider: "cursor", start_date: "2026-03-01", end_date: "2026-03-02" }, /does not support/],
    [{ provider: "openai", start_date: "2026-03-05", end_date: "2026-03-01" }, /on or before/],
    [{ provider: "openai", start_date: "2026-03-01", end_date: "2099-03-01" }, /.+/],
  ])("invalid range %p -> 400", async (body, msg) => {
    const r = await POST(req(body, { authorization: `Bearer ${SECRET}` }))
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(msg)
    expect(mockRun).not.toHaveBeenCalled()
  })

  test("no rollup refresh when collection errors", async () => {
    mockRun.mockResolvedValue({ status: "error", provider: "anthropic", error: "boom", timestamp: "t" })
    await POST(req({ provider: "anthropic", start_date: "2026-03-01", end_date: "2026-03-02" }, { authorization: `Bearer ${SECRET}` }))
    expect(mockRefresh).not.toHaveBeenCalled()
  })
})
