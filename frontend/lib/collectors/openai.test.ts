/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Unit tests for the OpenAI collector `transform` (pure, no network).
 *
 * Mirrors the Python transform_to_cost_records tests: validates the Costs
 * (authoritative USD) + Usage (tokens) merge.
 */

import { transform, collector, COST_GROUP_BY, USAGE_GROUP_BY } from "./openai"

// UTC midnight of 2026-06-01 in unix seconds.
const BUCKET_UNIX = Math.floor(Date.UTC(2026, 5, 1) / 1000)

const CTX = {
  userId: "user-1",
  providerId: "prov-openai",
  organizationId: "org-1",
}

describe("openai transform", () => {
  it("merges cost with matching usage", () => {
    const cost = [
      {
        start_time: BUCKET_UNIX,
        results: [
          {
            line_item: "gpt-4o",
            amount: { value: 0.06, currency: "usd" },
            project_id: "proj-1",
          },
        ],
      },
    ]
    const usage = [
      {
        start_time: BUCKET_UNIX,
        results: [
          {
            model: "gpt-4o",
            project_id: "proj-1",
            input_tokens: 1500,
            output_tokens: 500,
            num_model_requests: 10,
          },
        ],
      },
    ]

    const records = transform(cost, usage, CTX)
    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.model_name).toBe("gpt-4o")
    expect(r.cost_usd).toBeCloseTo(0.06)
    expect(r.input_tokens).toBe(1500)
    expect(r.output_tokens).toBe(500)
    expect(r.tokens_used).toBe(2000)
    expect(r.request_count).toBe(10)
    expect(r.collection_method).toBe("api_automated")
    expect(r.metadata.line_item).toBe("gpt-4o")
    expect(r.metadata.project_id).toBe("proj-1")
    expect(r.metadata.organization_id).toBe("org-1")
    expect(r.timestamp.startsWith("2026-06-01")).toBe(true)
  })

  it("leaves tokens null for cost without matching usage", () => {
    const cost = [
      {
        start_time: BUCKET_UNIX,
        results: [{ line_item: "web search tool", amount: { value: 2.5 } }],
      },
    ]
    const records = transform(cost, [], CTX)
    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.cost_usd).toBeCloseTo(2.5)
    expect(r.tokens_used).toBeNull()
    expect(r.input_tokens).toBeNull()
    expect(r.output_tokens).toBeNull()
    expect(r.request_count).toBe(1)
  })

  it("defaults model_name when line_item missing", () => {
    const cost = [
      { start_time: BUCKET_UNIX, results: [{ amount: { value: 1.0 } }] },
    ]
    const records = transform(cost, [], CTX)
    expect(records[0].model_name).toBe("openai")
  })

  it("skips buckets with a bad timestamp", () => {
    const cost = [
      {
        start_time: "not-a-unix",
        results: [{ line_item: "x", amount: { value: 1 } }],
      },
    ]
    expect(transform(cost, [], CTX)).toEqual([])
  })

  it("matches usage to line_item case-insensitively", () => {
    const cost = [
      {
        start_time: BUCKET_UNIX,
        results: [{ line_item: "GPT-4o", amount: { value: 0.5 } }],
      },
    ]
    const usage = [
      {
        start_time: BUCKET_UNIX,
        results: [
          {
            model: "gpt-4o",
            input_tokens: 100,
            output_tokens: 50,
            num_model_requests: 3,
          },
        ],
      },
    ]
    const r = transform(cost, usage, CTX)[0]
    expect(r.tokens_used).toBe(150)
    expect(r.request_count).toBe(3)
  })
})

describe("openai attribution", () => {
  const DAY2 = BUCKET_UNIX + 86400
  // Org totals per day (USD) for the fixture below.
  const ORG_DAILY_TOTAL: Record<string, number> = { "2026-06-01": 1.25 + 0.75 + 0.1, "2026-06-02": 3 }

  const cost = () => [
    {
      start_time: BUCKET_UNIX,
      results: [
        { line_item: "gpt-4o", project_id: "proj_a", api_key_id: "key_1", amount: { value: 1.25, currency: "usd" } },
        { line_item: "gpt-4o", project_id: "proj_a", api_key_id: "key_2", amount: { value: 0.75, currency: "usd" } },
        { line_item: "web search tool", project_id: "proj_b", api_key_id: null, amount: { value: 0.1, currency: "usd" } },
      ],
    },
    {
      start_time: DAY2,
      results: [{ line_item: "gpt-4o", project_id: null, api_key_id: null, amount: { value: 3, currency: "usd" } }],
    },
  ]
  const usage = () => [
    {
      start_time: BUCKET_UNIX,
      results: [
        { model: "gpt-4o", project_id: "proj_a", api_key_id: "key_1", user_id: "user_x", input_tokens: 10, output_tokens: 1, num_model_requests: 2 },
        { model: "gpt-4o", project_id: "proj_a", api_key_id: "key_1", user_id: "user_y", input_tokens: 5, output_tokens: 1, num_model_requests: 1 },
        { model: "gpt-4o", project_id: "proj_a", api_key_id: "key_2", user_id: null, input_tokens: 7, output_tokens: 2, num_model_requests: 4 },
      ],
    },
  ]
  const names = {
    projects: { proj_a: "Project A", proj_b: "Project B" },
    apiKeys: { key_1: { name: "ci-bot", owner_email: "dev@liatrio.example" } },
  }

  it("emits per api key / project rows with names", () => {
    const records = transform(cost(), usage(), CTX, names)
    expect(records).toHaveLength(4)
    const k1 = records.find((r) => (r.metadata.attribution as any).api_key_id === "key_1")!
    expect(k1.metadata.attribution).toEqual({
      granularity: "api_key",
      api_key_id: "key_1",
      api_key_name: "ci-bot",
      project_id: "proj_a",
      project_name: "Project A",
    })
    // usage summed across user_id; distinct users kept as a hint
    expect(k1.input_tokens).toBe(15)
    expect(k1.request_count).toBe(3)
    expect(k1.metadata.usage_user_ids).toEqual(["user_x", "user_y"])
    expect(k1.metadata.api_key_owner_email).toBe("dev@liatrio.example")

    const k2 = records.find((r) => (r.metadata.attribution as any).api_key_id === "key_2")!
    expect(k2.metadata.attribution).toEqual({ granularity: "api_key", api_key_id: "key_2", project_id: "proj_a", project_name: "Project A" })
    expect(k2.input_tokens).toBe(7)

    const proj = records.find((r) => r.model_name === "web search tool")!
    expect(proj.metadata.attribution).toEqual({ granularity: "project", project_id: "proj_b", project_name: "Project B" })

    const org = records.find((r) => r.timestamp.startsWith("2026-06-02"))!
    expect(org.metadata.attribution).toEqual({ granularity: "org" })
  })

  it("daily sum of finer rows equals the daily org total", () => {
    const sums: Record<string, number> = {}
    for (const r of transform(cost(), usage(), CTX, names)) {
      const d = r.timestamp.slice(0, 10)
      sums[d] = (sums[d] ?? 0) + r.cost_usd
    }
    for (const [d, total] of Object.entries(ORG_DAILY_TOTAL)) expect(sums[d]).toBeCloseTo(total, 9)
  })

  it("without key grouping on costs, usage joins on project only", () => {
    const c = [{ start_time: BUCKET_UNIX, results: [{ line_item: "gpt-4o", project_id: "proj_a", amount: { value: 2 } }] }]
    const records = transform(c, usage(), CTX, names, false)
    expect(records).toHaveLength(1)
    expect(records[0].input_tokens).toBe(22)
    expect(records[0].metadata.attribution).toEqual({ granularity: "project", project_id: "proj_a", project_name: "Project A" })
  })
})

describe("openai collect (mocked fetch)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
  const ctx = { apiKey: "test-admin-key", userId: "user-1", providerId: "prov-openai" }

  it("groups costs and usage by key/project, resolves names, and survives a failed key lookup", async () => {
    const seen: Record<string, string[]> = {}
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith("/costs")) {
        seen.costs = u.searchParams.getAll("group_by")
        return res({ data: [{ start_time: BUCKET_UNIX, results: [{ line_item: "gpt-4o", project_id: "proj_a", api_key_id: "key_1", amount: { value: 1 } }] }], has_more: false })
      }
      if (u.pathname.endsWith("/usage/completions")) {
        seen.usage = u.searchParams.getAll("group_by")
        return res({ data: [], has_more: false })
      }
      if (u.pathname.endsWith("/projects")) return res({ data: [{ id: "proj_a", name: "Project A" }], has_more: false })
      if (u.pathname.endsWith("/api_keys")) return res({ error: "forbidden" }, 403)
      throw new Error(`unexpected ${url}`)
    }) as any

    const records = await collector.collect(ctx)
    expect(seen.costs).toEqual(COST_GROUP_BY)
    expect(seen.usage).toEqual(USAGE_GROUP_BY)
    expect(records).toHaveLength(1)
    expect(records[0].metadata.attribution).toEqual({
      granularity: "api_key",
      api_key_id: "key_1",
      project_id: "proj_a",
      project_name: "Project A",
    })
  })

  it("retries /costs without api_key_id when the API rejects it (400)", async () => {
    const costGroupings: string[][] = []
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith("/costs")) {
        const g = u.searchParams.getAll("group_by")
        costGroupings.push(g)
        if (g.includes("api_key_id")) return res({ error: { message: "invalid group_by" } }, 400)
        return res({ data: [{ start_time: BUCKET_UNIX, results: [{ line_item: "gpt-4o", project_id: "proj_a", amount: { value: 2 } }] }], has_more: false })
      }
      if (u.pathname.endsWith("/usage/completions")) return res({ data: [], has_more: false })
      return res({}, 404) // name lookups fail entirely
    }) as any

    const records = await collector.collect(ctx)
    expect(costGroupings).toEqual([COST_GROUP_BY, ["line_item", "project_id"]])
    expect(records).toHaveLength(1)
    expect(records[0].metadata.attribution).toEqual({ granularity: "project", project_id: "proj_a" })
  })
})

describe("openai collect with an explicit range (issue #20)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
  const ctx = { apiKey: "test-admin-key", userId: "user-1", providerId: "prov-openai" }
  const unix = (iso: string) => String(Date.parse(iso) / 1000)

  it("requests exactly start_time/end_time for the range, on costs and usage", async () => {
    const seen: Record<string, string[][]> = { costs: [], usage: [] }
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      const span = [u.searchParams.get("start_time")!, u.searchParams.get("end_time")!]
      if (u.pathname.endsWith("/costs")) seen.costs.push(span)
      else if (u.pathname.endsWith("/usage/completions")) seen.usage.push(span)
      else return res({ data: [], has_more: false })
      return res({ data: [], has_more: false })
    }) as any
    await collector.collect(ctx, {
      range: { start: new Date("2026-02-01T00:00:00Z"), end: new Date("2026-03-04T00:00:00Z") },
    })
    const want = [[unix("2026-02-01T00:00:00Z"), unix("2026-03-04T00:00:00Z")]]
    expect(seen.costs).toEqual(want)
    expect(seen.usage).toEqual(want)
  })

  it("pages through a >31-bucket range with the same window on every page", async () => {
    const costPages: Array<[string | null, string | null, string | null]> = []
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith("/costs")) {
        const page = u.searchParams.get("page")
        costPages.push([u.searchParams.get("start_time"), u.searchParams.get("end_time"), page])
        return page
          ? res({ data: [], has_more: false })
          : res({ data: [], has_more: true, next_page: "p2" })
      }
      return res({ data: [], has_more: false })
    }) as any
    await collector.collect(ctx, {
      range: { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-03-10T00:00:00Z") },
    })
    const s = unix("2026-01-01T00:00:00Z")
    const e = unix("2026-03-10T00:00:00Z")
    expect(costPages).toEqual([
      [s, e, null],
      [s, e, "p2"],
    ])
  })
})
