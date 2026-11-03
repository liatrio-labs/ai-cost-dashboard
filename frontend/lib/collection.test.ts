/**
 * @jest-environment node
 *
 * Cron trigger helper: CRON_SECRET only, optional start_date/end_date via the
 * shared validator (issue #20). Runner mocked; no network, no database.
 */

import { NextRequest } from "next/server"

const mockRun = jest.fn()
jest.mock("@/lib/collectors/runner", () => ({
  runCollectionForProvider: (...args: unknown[]) => mockRun(...args),
}))

import { triggerProviderCollection, safeEqual } from "./collection"

// Test-only placeholders, never real secrets.
const CRON = "test-cron-secret"
const TRIGGER = "test-trigger-secret"

const get = (qs: string, auth?: string) =>
  new NextRequest(`http://localhost/api/cron/anthropic${qs}`, {
    headers: auth ? { authorization: auth } : {},
  })

describe("triggerProviderCollection", () => {
  const saved = { cron: process.env.CRON_SECRET, trig: process.env.COLLECTION_TRIGGER_SECRET }
  beforeEach(() => {
    process.env.CRON_SECRET = CRON
    process.env.COLLECTION_TRIGGER_SECRET = TRIGGER
    mockRun.mockReset().mockResolvedValue({ status: "success", provider: "anthropic", timestamp: "t" })
    jest.spyOn(console, "log").mockImplementation(() => {})
  })
  afterAll(() => {
    for (const [k, v] of [["CRON_SECRET", saved.cron], ["COLLECTION_TRIGGER_SECRET", saved.trig]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    jest.restoreAllMocks()
  })

  test("cron routes stay CRON_SECRET-only", async () => {
    expect((await triggerProviderCollection(get("", `Bearer ${TRIGGER}`), "anthropic")).status).toBe(401)
    expect((await triggerProviderCollection(get(""), "anthropic")).status).toBe(401)
    expect((await triggerProviderCollection(get("", `Bearer ${CRON}`), "anthropic")).status).toBe(200)
    expect(mockRun).toHaveBeenCalledWith("anthropic", {})
  })

  test("backfill query params unchanged", async () => {
    await triggerProviderCollection(get("?backfill=true&days=45", `Bearer ${CRON}`), "anthropic")
    expect(mockRun).toHaveBeenCalledWith("anthropic", { backfill: true, backfillDays: 45 })
  })

  test("start_date/end_date use the shared validator", async () => {
    const ok = await triggerProviderCollection(get("?start_date=2026-07-23&end_date=2026-07-23", `Bearer ${CRON}`), "anthropic")
    expect(ok.status).toBe(200)
    expect(mockRun).toHaveBeenCalledWith("anthropic", {
      range: { start: new Date("2026-07-23T00:00:00Z"), end: new Date("2026-07-24T00:00:00Z") },
    })
    expect((await ok.json()).range).toMatchObject({ start_date: "2026-07-23", end_date: "2026-07-23" })

    mockRun.mockClear()
    const bad = await triggerProviderCollection(get("?start_date=2026-07-23", `Bearer ${CRON}`), "anthropic")
    expect(bad.status).toBe(400)
    expect(mockRun).not.toHaveBeenCalled()
  })
})

describe("safeEqual", () => {
  test("compares by value, any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
  })
})
