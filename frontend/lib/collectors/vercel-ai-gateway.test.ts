/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Pure transform tests for the Vercel AI Gateway collector. No network.
 */

import { transform, collector } from "./vercel-ai-gateway"
import type { CostRecord } from "./types"

const ctx = { userId: "user-1", providerId: "provider-aigw", teamId: "team_x" }

function sample() {
  return [
    {
      day: "2026-05-26",
      total_cost: 39.0951844,
      market_cost: 39.1047214,
      input_tokens: 4269396,
      output_tokens: 310781,
      cached_input_tokens: 2242228,
      cache_creation_input_tokens: 1926797,
      reasoning_tokens: 0,
      request_count: 406,
    },
    {
      day: "2026-05-27",
      total_cost: 60.09975725,
      input_tokens: 6399356,
      output_tokens: 347159,
      request_count: 635,
    },
  ]
}

function byDay(records: CostRecord[]): Record<string, CostRecord> {
  const out: Record<string, CostRecord> = {}
  for (const r of records) out[r.timestamp.slice(0, 10)] = r
  return out
}

describe("vercel-ai-gateway transform", () => {
  test("one record per UTC day; total_cost is cost_usd", () => {
    const m = byDay(transform(sample(), ctx))
    expect(m["2026-05-26"].cost_usd).toBeCloseTo(39.0951844)
    expect(m["2026-05-27"].cost_usd).toBeCloseTo(60.09975725)
  })

  test("tokens summed; model_name ai-gateway; UTC midnight", () => {
    const r = byDay(transform(sample(), ctx))["2026-05-26"]
    expect(r.input_tokens).toBe(4269396)
    expect(r.output_tokens).toBe(310781)
    expect(r.tokens_used).toBe(4269396 + 310781)
    expect(r.request_count).toBe(406)
    expect(r.model_name).toBe("ai-gateway")
    expect(r.timestamp.endsWith("T00:00:00.000Z")).toBe(true)
    expect(r.collection_method).toBe("api_automated")
  })

  test("metadata carries market_cost, cache + reasoning tokens, team", () => {
    const r = byDay(transform(sample(), ctx))["2026-05-26"]
    expect(r.metadata.market_cost).toBeCloseTo(39.1047214)
    expect(r.metadata.cached_input_tokens).toBe(2242228)
    expect(r.metadata.cache_creation_input_tokens).toBe(1926797)
    expect(r.metadata.team_id).toBe("team_x")
    expect(r.metadata.provider).toBe("vercel-ai-gateway")
  })

  test("skips rows with missing/unparseable day", () => {
    const recs = transform(
      [
        { day: undefined, total_cost: 5 },
        { day: "not-a-date", total_cost: 5 },
        { day: "2026-05-28", total_cost: 1 },
      ] as any,
      ctx
    )
    expect(recs.length).toBe(1)
    expect(recs[0].timestamp.slice(0, 10)).toBe("2026-05-28")
  })
})

describe("vercel-ai-gateway per-key attribution", () => {
  const total = () => [
    { day: "2026-10-01", total_cost: 10, market_cost: 12, input_tokens: 1000, output_tokens: 100, request_count: 50 },
    { day: "2026-10-02", total_cost: 4, market_cost: 4, input_tokens: 400, output_tokens: 40, request_count: 20 },
  ]
  const keyReports = () => [
    {
      key: { id: "key_a", name: "prod-app" },
      rows: [
        { day: "2026-10-01", total_cost: 6.5, market_cost: 7, input_tokens: 600, output_tokens: 60, request_count: 30 },
        { day: "2026-10-02", total_cost: 4, market_cost: 4, input_tokens: 400, output_tokens: 40, request_count: 20 },
      ],
    },
    {
      key: { id: "key_b", name: null },
      rows: [
        { day: "2026-10-01", total_cost: 2.25, market_cost: 3, input_tokens: 300, output_tokens: 30, request_count: 15 },
        { day: "2026-10-02", total_cost: 0, input_tokens: 0, output_tokens: 0, request_count: 0 }, // idle -> no row
      ],
    },
  ]

  test("per-key rows plus an org remainder row sum to the unfiltered daily total", () => {
    const records = transform(total(), ctx, keyReports())
    for (const t of total()) {
      const day = records.filter((r) => r.timestamp.startsWith(t.day))
      expect(day.reduce((s, r) => s + r.cost_usd, 0)).toBeCloseTo(t.total_cost, 9)
      expect(day.reduce((s, r) => s + (r.input_tokens ?? 0), 0)).toBe(t.input_tokens)
    }
    const d1 = records.filter((r) => r.timestamp.startsWith("2026-10-01"))
    expect(d1).toHaveLength(3)
    const a = d1.find((r) => (r.metadata.attribution as any).api_key_id === "key_a")!
    expect(a.metadata.attribution).toEqual({ granularity: "api_key", api_key_id: "key_a", api_key_name: "prod-app" })
    const rem = d1.find((r) => r.metadata.remainder)!
    expect(rem.metadata.attribution).toEqual({ granularity: "org" })
    expect(rem.cost_usd).toBeCloseTo(1.25)
    expect(rem.metadata.market_cost).toBeCloseTo(2)
    expect(rem.model_name).toBe("ai-gateway")

    // Day 2 is fully covered by key_a: no remainder row, no idle key_b row.
    const d2 = records.filter((r) => r.timestamp.startsWith("2026-10-02"))
    expect(d2).toHaveLength(1)
    expect((d2[0].metadata.attribution as any).api_key_id).toBe("key_a")
  })

  test("without key reports every row is org-level", () => {
    for (const r of transform(total(), ctx)) expect(r.metadata.attribution).toEqual({ granularity: "org" })
  })
})

describe("vercel-ai-gateway collect (mocked fetch)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
  })
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
  const base = { apiKey: "test-gateway-key", userId: "user-1", providerId: "prov-aigw", teamId: "team_x" }
  const today = new Date().toISOString().slice(0, 10)

  test("lists keys with the aux Vercel token and queries the report once per key", async () => {
    const reportKeys: (string | null)[] = []
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.hostname === "api.vercel.com") {
        expect(u.searchParams.get("purpose")).toBe("ai-gateway")
        return res({ apiKeys: [{ id: "key_a", name: "prod-app" }] })
      }
      const k = u.searchParams.get("api_key_id")
      reportKeys.push(k)
      expect(u.searchParams.get("group_by")).toBe("day")
      return res({ results: [{ day: today, total_cost: k ? 3 : 5, request_count: 1 }] })
    }) as any

    const records = await collector.collect({ ...base, auxApiKey: "test-vercel-token" })
    expect(reportKeys.sort()).toEqual([null, "key_a"].sort())
    expect(records.map((r) => (r.metadata.attribution as any).granularity).sort()).toEqual(["api_key", "org"])
    expect(records.reduce((s, r) => s + r.cost_usd, 0)).toBeCloseTo(5)
  })

  test("a failed per-key query falls back to org totals only", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.hostname === "api.vercel.com") return res({ apiKeys: [{ id: "key_a" }, { id: "key_b" }] })
      if (u.searchParams.get("api_key_id") === "key_b") return res({ error: "bad" }, 400)
      return res({ results: [{ day: today, total_cost: 5 }] })
    }) as any
    const records = await collector.collect({ ...base, auxApiKey: "test-vercel-token" })
    expect(records).toHaveLength(1)
    expect(records[0].metadata.attribution).toEqual({ granularity: "org" })
    expect(records[0].cost_usd).toBe(5)
  })

  test("no aux token: org rows only, no key listing", async () => {
    const hosts: string[] = []
    global.fetch = jest.fn(async (url: any) => {
      hosts.push(new URL(String(url)).hostname)
      return res({ results: [{ day: today, total_cost: 1 }] })
    }) as any
    const records = await collector.collect(base)
    expect(hosts).toEqual(["ai-gateway.vercel.sh"])
    expect(records[0].metadata.attribution).toEqual({ granularity: "org" })
  })
})
