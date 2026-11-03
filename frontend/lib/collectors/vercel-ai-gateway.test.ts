/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Pure transform tests for the Vercel AI Gateway collector. No network.
 */

import { transform, collector, listGatewayKeys, lookupProjectNames, parseSpendAttribution } from "./vercel-ai-gateway"
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

describe("listGatewayKeys pagination (mocked fetch)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `key_${from + i}`, name: `k${from + i}` }))

  test("follows pagination.next as `until` across pages", async () => {
    const untils: (string | null)[] = []
    global.fetch = jest.fn(async (url: string) => {
      const until = new URL(String(url)).searchParams.get("until")
      untils.push(until)
      if (!until) return res({ apiKeys: page(0, 100), pagination: { next: 1700000000000 } })
      return res({ apiKeys: page(100, 30), pagination: { next: null } })
    }) as unknown as typeof fetch
    const keys = await listGatewayKeys("test-vercel-token", "team_x")
    expect(untils).toEqual([null, "1700000000000"])
    expect(keys).toHaveLength(130)
    expect(keys[129]).toEqual({ id: "key_129", name: "k129" })
  })

  test("caps at 200 keys and keeps earlier pages if a later page fails", async () => {
    let calls = 0
    global.fetch = jest.fn(async () => {
      calls++
      if (calls <= 3) return res({ apiKeys: page((calls - 1) * 100, 100), pagination: { next: calls } })
      return res({}, 403)
    }) as unknown as typeof fetch
    const keys = await listGatewayKeys("test-vercel-token")
    expect(keys).toHaveLength(200)
    expect(calls).toBe(2)

    calls = 0
    global.fetch = jest.fn(async () => {
      calls++
      return calls === 1 ? res({ apiKeys: page(0, 100), pagination: { next: 1 } }) : res({}, 403)
    }) as unknown as typeof fetch
    expect(await listGatewayKeys("test-vercel-token")).toHaveLength(100)
  })

  test("stops when the cursor repeats keys instead of looping", async () => {
    global.fetch = jest.fn(async () => res({ apiKeys: page(0, 5), pagination: { next: 1 } })) as unknown as typeof fetch
    expect(await listGatewayKeys("test-vercel-token")).toHaveLength(5)
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2)
  })
})

describe("vercel-ai-gateway key metadata and projects (issue #24)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
  })
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
  const base = { apiKey: "test-gateway-key", userId: "user-1", providerId: "prov-aigw", teamId: "team_x", auxApiKey: "test-vercel-token" }
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  const apiKeys = [
    { id: "k_user", name: "alice laptop", createdBy: "uid_alice", metadata: { spendAttribution: "user" } },
    { id: "k_proj", name: "web app", createdBy: "uid_bob", projectId: "prj_web", metadata: { spendAttribution: "team" } },
    { id: "k_unset", name: "legacy", createdBy: "uid_bob" },
  ]
  // Unfiltered daily totals and per-key reports (today and yesterday).
  const report: Record<string, { day: string; total_cost: number; input_tokens: number; request_count: number }[]> = {
    all: [
      { day: yesterday, total_cost: 10, input_tokens: 1000, request_count: 10 },
      { day: today, total_cost: 7.5, input_tokens: 700, request_count: 7 },
    ],
    k_user: [
      { day: yesterday, total_cost: 4, input_tokens: 400, request_count: 4 },
      { day: today, total_cost: 2.5, input_tokens: 200, request_count: 2 },
    ],
    k_proj: [
      { day: yesterday, total_cost: 3, input_tokens: 300, request_count: 3 },
      { day: today, total_cost: 5, input_tokens: 500, request_count: 5 },
    ],
    k_unset: [{ day: yesterday, total_cost: 1, input_tokens: 100, request_count: 1 }],
  }

  function mockFetch(projectLookup: (id: string) => Response | Promise<Response>) {
    const seen: string[] = []
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      seen.push(`${u.hostname}${u.pathname}`)
      if (u.hostname === "api.vercel.com" && u.pathname === "/v1/api-keys") return res({ apiKeys })
      if (u.hostname === "api.vercel.com" && u.pathname.startsWith("/v9/projects/")) {
        expect(u.searchParams.get("teamId")).toBe("team_x")
        return projectLookup(decodeURIComponent(u.pathname.split("/").pop()!))
      }
      return res({ results: report[u.searchParams.get("api_key_id") ?? "all"] ?? [] })
    }) as any
    return seen
  }

  test("listGatewayKeys carries projectId, createdBy and spendAttribution", async () => {
    mockFetch(() => res({}))
    const keys = await listGatewayKeys("test-vercel-token", "team_x")
    expect(keys).toEqual([
      { id: "k_user", name: "alice laptop", createdBy: "uid_alice", spendAttribution: "user" },
      { id: "k_proj", name: "web app", createdBy: "uid_bob", projectId: "prj_web", spendAttribution: "team" },
      { id: "k_unset", name: "legacy", createdBy: "uid_bob" },
    ])
  })

  test("each day's per-key rows plus the remainder equal the unfiltered /v1/report total", async () => {
    mockFetch(() => res({ id: "prj_web", name: "Website" }))
    const records = await collector.collect(base)
    for (const t of report.all) {
      const day = records.filter((r) => r.timestamp.startsWith(t.day))
      expect(day.reduce((s, r) => s + r.cost_usd, 0)).toBeCloseTo(t.total_cost, 9)
      expect(day.reduce((s, r) => s + (r.input_tokens ?? 0), 0)).toBe(t.input_tokens)
    }
    const y = records.filter((r) => r.timestamp.startsWith(yesterday))
    // 3 keys + remainder (10 - 4 - 3 - 1 = 2)
    expect(y).toHaveLength(4)
    expect(y.find((r) => r.metadata.remainder)!.cost_usd).toBeCloseTo(2)
    // today: k_user 2.5 + k_proj 5 = 7.5 -> no remainder row
    expect(records.filter((r) => r.timestamp.startsWith(today)).some((r) => r.metadata.remainder)).toBe(false)
  })

  test("project-scoped key rows set attribution.project_id/project_name; api_key stays the granularity", async () => {
    mockFetch(() => res({ id: "prj_web", name: "Website" }))
    const records = await collector.collect(base)
    const proj = records.filter((r) => (r.metadata.attribution as any).api_key_id === "k_proj")
    expect(proj).toHaveLength(2)
    for (const r of proj) {
      expect(r.metadata.attribution).toEqual({
        granularity: "api_key",
        api_key_id: "k_proj",
        api_key_name: "web app",
        project_id: "prj_web",
        project_name: "Website",
      })
      expect(r.metadata.gateway_key).toEqual({ project_id: "prj_web", created_by: "uid_bob", spend_attribution: "team" })
    }
    const user = records.find((r) => (r.metadata.attribution as any).api_key_id === "k_user")!
    expect(user.metadata.attribution).toEqual({ granularity: "api_key", api_key_id: "k_user", api_key_name: "alice laptop" })
    expect(user.metadata.gateway_key).toEqual({ project_id: null, created_by: "uid_alice", spend_attribution: "user" })
    const unset = records.find((r) => (r.metadata.attribution as any).api_key_id === "k_unset")!
    expect(unset.metadata.gateway_key).toEqual({ project_id: null, created_by: "uid_bob", spend_attribution: null })
    // The remainder row stays org-level and carries no key metadata.
    const rem = records.find((r) => r.metadata.remainder)!
    expect(rem.metadata.attribution).toEqual({ granularity: "org" })
    expect(rem.metadata.gateway_key).toBeUndefined()
  })

  test("a failed project lookup leaves project_name null and never fails collection", async () => {
    for (const lookup of [() => res({ error: "forbidden" }, 403), () => Promise.reject(new Error("network down"))]) {
      mockFetch(lookup)
      const records = await collector.collect(base)
      const proj = records.find((r) => (r.metadata.attribution as any).api_key_id === "k_proj")!
      expect(proj.metadata.attribution).toEqual({ granularity: "api_key", api_key_id: "k_proj", api_key_name: "web app", project_id: "prj_web" })
      expect(records.reduce((s, r) => s + r.cost_usd, 0)).toBeCloseTo(17.5)
    }
  })

  test("the all-or-nothing fallback still applies with scoped keys", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname === "/v1/api-keys") return res({ apiKeys })
      if (u.pathname.startsWith("/v9/projects/")) return res({ name: "Website" })
      if (u.searchParams.get("api_key_id") === "k_proj") return res({ error: "bad" }, 400)
      return res({ results: report[u.searchParams.get("api_key_id") ?? "all"] ?? [] })
    }) as any
    const records = await collector.collect(base)
    expect(records).toHaveLength(2)
    for (const r of records) expect(r.metadata.attribution).toEqual({ granularity: "org" })
  })

  test("parseSpendAttribution accepts user/team only", () => {
    expect(parseSpendAttribution("User")).toBe("user")
    expect(parseSpendAttribution("team")).toBe("team")
    expect(parseSpendAttribution("everyone")).toBeNull()
    expect(parseSpendAttribution(undefined)).toBeNull()
  })

  test("lookupProjectNames caps lookups and dedupes ids", async () => {
    const calls: string[] = []
    global.fetch = jest.fn(async (url: any) => {
      calls.push(String(url))
      return res({ name: "n" })
    }) as any
    const ids = Array.from({ length: 60 }, (_, i) => `prj_${i}`)
    const names = await lookupProjectNames("test-vercel-token", [...ids, "prj_0"])
    expect(calls).toHaveLength(50)
    expect(names.size).toBe(50)
  })
})
