/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Unit tests for the Claude Enterprise Analytics transform.
 *
 * These exercise the pure `transform` function only — no network. Confirms the
 * cents->USD division (by 100), model_name never null, token aggregation, null
 * tokens when usage is absent, and that bad buckets/results are skipped.
 */

import { transform, transformAnalytics, collector } from "./claude-ai"

const CTX = {
  userId: "user-123",
  providerId: "provider-abc",
  organizationId: "org-xyz",
}

function costBuckets() {
  // Amounts are in fractional cents.
  return [
    {
      starting_at: "2026-06-23T00:00:00Z",
      ending_at: "2026-06-24T00:00:00Z",
      results: [
        {
          model: "claude-sonnet-4-5",
          product: "claude_code",
          cost_type: "tokens",
          currency: "USD",
          amount: 1500, // $15.00
          list_amount: 3000, // $30.00
        },
        {
          // No model -> must fall back to "claude-ai", never null.
          model: null,
          product: "claude_chat",
          currency: "USD",
          amount: 250, // $2.50
          list_amount: null,
        },
      ],
    },
  ]
}

function usageBuckets() {
  return [
    {
      starting_at: "2026-06-23T00:00:00Z",
      ending_at: "2026-06-24T00:00:00Z",
      results: [
        {
          model: "claude-sonnet-4-5",
          product: "claude_code",
          uncached_input_tokens: 1000,
          cache_read_input_tokens: 200,
          cache_creation: {
            ephemeral_5m_input_tokens: 80,
            ephemeral_1h_input_tokens: 20,
          },
          output_tokens: 500,
          requests: 12,
        },
        // No usage for the chat result -> tokens stay null.
      ],
    },
  ]
}

describe("transform", () => {
  test("basic transform: cost (cents/100) and model", () => {
    const records = transform(costBuckets(), usageBuckets(), CTX)
    expect(records).toHaveLength(2)

    const sonnet = records.find((r) => r.model_name === "claude-sonnet-4-5")!
    // 1500 fractional cents -> $15.00
    expect(sonnet.cost_usd).toBeCloseTo(15.0)
    expect(sonnet.metadata.list_amount_usd).toBeCloseTo(30.0)
    expect(sonnet.collection_method).toBe("api_automated")
    expect(sonnet.request_count).toBe(12)
    expect(sonnet.user_id).toBe("user-123")
    expect(sonnet.provider_id).toBe("provider-abc")
    expect(sonnet.metadata.provider).toBe("claude-ai")
    expect(sonnet.metadata.organization_id).toBe("org-xyz")
    expect(sonnet.metadata.bucket_width).toBe("1d")
  })

  test("model_name is never null", () => {
    const records = transform(costBuckets(), usageBuckets(), CTX)
    for (const r of records) {
      expect(r.model_name).not.toBeNull()
      expect(r.model_name).not.toBe("")
    }
    // The result with model=null must become the "claude-ai" fallback.
    expect(records.some((r) => r.model_name === "claude-ai")).toBe(true)
  })

  test("token aggregation sums input flavours plus output", () => {
    const records = transform(costBuckets(), usageBuckets(), CTX)
    const sonnet = records.find((r) => r.model_name === "claude-sonnet-4-5")!
    // uncached (1000) + cache_read (200) + nested cache_creation (80+20) = 1300 input
    expect(sonnet.input_tokens).toBe(1300)
    expect(sonnet.output_tokens).toBe(500)
    expect(sonnet.tokens_used).toBe(1800)
  })

  test("nested cache_creation tokens are counted (Analytics API shape)", () => {
    const cost: any[] = [
      {
        starting_at: "2026-08-01T00:00:00Z",
        results: [{ model: "claude-opus-4-6", amount: 100, requests: 3 }],
      },
    ]
    const usage: any[] = [
      {
        starting_at: "2026-08-01T00:00:00Z",
        results: [
          {
            model: "claude-opus-4-6",
            uncached_input_tokens: 10,
            cache_read_input_tokens: 5,
            cache_creation: {
              ephemeral_5m_input_tokens: 1000,
              ephemeral_1h_input_tokens: 500,
            },
            output_tokens: 7,
            requests: 3,
          },
        ],
      },
    ]
    const records = transform(cost, usage, CTX)
    expect(records).toHaveLength(1)
    expect(records[0].input_tokens).toBe(1515)
    expect(records[0].output_tokens).toBe(7)
    expect(records[0].tokens_used).toBe(1522)
    expect(records[0].request_count).toBe(3)
  })

  test("dotted cache_creation keys still count when nested object is absent", () => {
    const cost: any[] = [
      {
        starting_at: "2026-08-01T00:00:00Z",
        results: [{ model: "claude-haiku", amount: 50 }],
      },
    ]
    const usage: any[] = [
      {
        starting_at: "2026-08-01T00:00:00Z",
        results: [
          {
            model: "claude-haiku",
            uncached_input_tokens: 1,
            "cache_creation.ephemeral_5m_input_tokens": 40,
            "cache_creation.ephemeral_1h_input_tokens": 9,
            output_tokens: 2,
          },
        ],
      },
    ]
    const records = transform(cost, usage, CTX)
    expect(records[0].input_tokens).toBe(50)
    expect(records[0].request_count).toBe(1) // no requests field -> default
  })

  test("missing usage yields null tokens", () => {
    const records = transform(costBuckets(), usageBuckets(), CTX)
    const chat = records.find((r) => r.model_name === "claude-ai")!
    expect(chat.input_tokens).toBeNull()
    expect(chat.output_tokens).toBeNull()
    expect(chat.tokens_used).toBeNull()
    // 250 fractional cents -> $2.50
    expect(chat.cost_usd).toBeCloseTo(2.5)
    expect(chat.metadata.list_amount_usd).toBeNull()
  })

  test("timestamp is tz-aware ISO", () => {
    const records = transform(costBuckets(), usageBuckets(), CTX)
    const ts = records[0].timestamp
    const parsed = new Date(ts)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    // ISO string carries the UTC zone designator.
    expect(ts.endsWith("Z")).toBe(true)
    expect(ts.startsWith("2026-06-23T00:00:00")).toBe(true)
  })

  test("unparseable bucket / result is skipped", () => {
    const cost: any[] = [
      { starting_at: null, results: [{ amount: 100 }] }, // no start -> skip
      "not-a-dict", // non-dict bucket -> skip
      {
        starting_at: "2026-06-23T00:00:00Z",
        results: [
          { model: "claude-opus", amount: 999 },
          "not-a-dict-result", // skipped
        ],
      },
    ]
    const records = transform(cost, [], CTX)
    expect(records).toHaveLength(1)
    expect(records[0].model_name).toBe("claude-opus")
    expect(records[0].cost_usd).toBeCloseTo(9.99)
  })

  test("unparseable amount defaults to zero", () => {
    const cost: any[] = [
      {
        starting_at: "2026-06-23T00:00:00Z",
        results: [{ model: "claude-haiku", amount: "not-a-number" }],
      },
    ]
    const records = transform(cost, [], CTX)
    expect(records).toHaveLength(1)
    expect(records[0].cost_usd).toBe(0.0)
  })

  test("empty / nullish input yields no records", () => {
    expect(transform([], [], CTX)).toEqual([])
    expect(transform(null as any, null as any, CTX)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Usage & Cost Analytics API (per actor)
// ---------------------------------------------------------------------------

describe("claude-ai transformAnalytics", () => {
  const D = "2026-10-05T00:00:00Z"
  const E = "2026-10-06T00:00:00Z"
  const BOB = { type: "user_actor", user_id: "user_bob", email_address: "BOB@liatrio.example", name: "Bob", deleted: false }
  const CAROL = { type: "user_actor", user_id: "user_carol", email_address: "carol@liatrio.example", name: null, deleted: true }

  // 150 distinct people on one day: more groups than the legacy top-100 cap.
  function manyPeople() {
    return Array.from({ length: 150 }, (_, i) => ({
      starting_at: D,
      ending_at: E,
      group: {
        actor: { type: "user_actor", user_id: `u${i}`, email_address: `p${i}@liatrio.example`, name: null, deleted: false },
        model: "claude-sonnet-4-5",
        product: "claude_chat",
      },
      cost: { amount: "1.500000", currency: "USD", requests: 1 },
    }))
  }

  const cost = () => [
    { starting_at: D, ending_at: E, group: { actor: BOB, model: "claude-opus-4-6", product: "claude_code" }, cost: { amount: "2000.000000", list_amount: "2500.000000", currency: "USD", requests: 7 } },
    { starting_at: D, ending_at: E, group: { actor: CAROL, model: null, product: "claude_chat" }, cost: { amount: "125.500000", currency: "USD", requests: 3 } },
    { starting_at: D, ending_at: E, group: { actor: null, model: "claude-haiku-4-5", product: "api" }, cost: { amount: "10.000000", currency: "USD", requests: null } },
    ...manyPeople(),
  ]
  const usage = () => [
    {
      starting_at: D,
      ending_at: E,
      group: { actor: BOB, model: "claude-opus-4-6", product: "claude_code" },
      usage: { uncached_input_tokens: 1000, cache_read_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 }, output_tokens: 300, requests: 7 },
    },
  ]
  // Org total for 2026-10-05 in USD: 20.00 + 1.255 + 0.10 + 150 * 0.015
  const ORG_TOTAL_USD = 20 + 1.255 + 0.1 + 150 * 0.015

  test("actor email -> person_email (lower-cased); one row per cost group", () => {
    const records = transformAnalytics(cost(), usage(), CTX)
    expect(records).toHaveLength(153)
    const bob = records.find((r) => (r.metadata.attribution as any).person_email === "bob@liatrio.example")!
    expect(bob.metadata.attribution).toEqual({
      granularity: "person",
      person_email: "bob@liatrio.example",
      person_external_id: "user_bob",
      person_name: "Bob",
    })
    expect(bob.cost_usd).toBeCloseTo(20)
    expect(bob.metadata.list_amount_usd).toBeCloseTo(25)
    expect(bob.input_tokens).toBe(1600)
    expect(bob.output_tokens).toBe(300)
    expect(bob.request_count).toBe(7)
    expect(bob.metadata.group).toEqual({ model: "claude-opus-4-6", product: "claude_code" })

    const carol = records.find((r) => (r.metadata.attribution as any).person_email === "carol@liatrio.example")!
    expect(carol.model_name).toBe("claude-ai")
    expect(carol.tokens_used).toBeNull()
    expect(carol.request_count).toBe(3)

    const none = records.find((r) => r.metadata.actor_type === null)!
    expect(none.metadata.attribution).toEqual({ granularity: "org" })
  })

  test("daily sum of per-person rows equals the org total (beyond the legacy top-100 cap)", () => {
    const records = transformAnalytics(cost(), usage(), CTX)
    const sum = records.reduce((s, r) => s + r.cost_usd, 0)
    expect(sum).toBeCloseTo(ORG_TOTAL_USD, 6)
    expect(records.filter((r) => (r.metadata.attribution as any).granularity === "person")).toHaveLength(152)
  })

  test("legacy transform rows are org-level", () => {
    const records = transform(costBuckets(), usageBuckets(), CTX)
    for (const r of records) expect(r.metadata.attribution).toEqual({ granularity: "org" })
  })
})

describe("claude-ai collect (mocked fetch)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
  })
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
  const ctx = { apiKey: "test-analytics-key", userId: "user-1", providerId: "prov-claude-ai" }

  test("queries /analytics/cost + /usage grouped by actor,model,product over 31 days", async () => {
    const urls: URL[] = []
    global.fetch = jest.fn(async (url: any, init: any) => {
      expect(init.headers["anthropic-beta"]).toBe("analytics-usage-cost-2026-08-24")
      const u = new URL(String(url))
      urls.push(u)
      return res({ data: [], has_more: false, next_page: null })
    }) as any
    await collector.collect(ctx)
    expect(urls.map((u) => u.pathname).sort()).toEqual([
      "/v1/organizations/analytics/cost",
      "/v1/organizations/analytics/usage",
    ])
    for (const u of urls) {
      expect(u.searchParams.getAll("group_by[]")).toEqual(["actor", "model", "product"])
      const span = Date.parse(u.searchParams.get("ending_at")!) - Date.parse(u.searchParams.get("starting_at")!)
      expect(span).toBeLessThanOrEqual(31 * 24 * 3600 * 1000)
    }
  })

  test("falls back to the legacy cost_report on 403", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    global.fetch = jest.fn(async (url: any) => {
      const p = new URL(String(url)).pathname
      if (p.endsWith("/analytics/cost") || p.endsWith("/analytics/usage")) return res({}, 403)
      if (p.endsWith("/cost_report")) return res({ data: costBuckets(), has_more: false })
      return res({ data: usageBuckets(), has_more: false })
    }) as any
    const records = await collector.collect(ctx)
    expect(records.length).toBeGreaterThan(0)
    expect(records[0].metadata.source).toBe("cost_report")
  })
})
