/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Unit tests for the Anthropic collector transform (pure, no network).
 *
 * Validates the merge of Admin API usage + cost buckets into cost_records rows.
 */

import { transform, transformAnalytics, collector, ANALYTICS_GROUP_BY } from "./anthropic"

const CTX = {
  userId: "user-1",
  providerId: "prov-anthropic",
  organizationId: "org-1",
}

describe("anthropic transform", () => {
  test("merges usage and cost by bucket and model", () => {
    const usage = [
      {
        starting_at: "2026-06-01T00:00:00Z",
        results: [
          {
            model: "claude-sonnet-4-5",
            uncached_input_tokens: 1000,
            cache_read_input_tokens: 200,
            output_tokens: 500,
            request_count: 5,
          },
        ],
      },
    ]
    const cost = [
      {
        starting_at: "2026-06-01T00:00:00Z",
        results: [
          { model: "claude-sonnet-4-5", amount: "1234", currency: "USD" }, // cents -> $12.34
        ],
      },
    ]

    const records = transform(usage, cost, CTX)
    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.model_name).toBe("claude-sonnet-4-5")
    expect(r.cost_usd).toBeCloseTo(12.34)
    expect(r.input_tokens).toBe(1200) // 1000 uncached + 200 cache read
    expect(r.output_tokens).toBe(500)
    expect(r.tokens_used).toBe(1700)
    expect(r.request_count).toBe(5)
    expect(r.collection_method).toBe("api_automated")
    expect(r.provider_id).toBe("prov-anthropic")
    expect(r.user_id).toBe("user-1")
    expect(r.timestamp.startsWith("2026-06-01")).toBe(true)
    expect(r.metadata).toEqual({
      provider: "anthropic",
      bucket_width: "1d",
      organization_id: "org-1",
      source: "cost_report",
      attribution: { granularity: "org" },
    })
  })

  test("cost-only model has zero tokens and default request count", () => {
    const cost = [
      {
        starting_at: "2026-06-02T00:00:00Z",
        results: [{ model: "claude-opus-4", amount: "300" }], // cents -> $3.00
      },
    ]
    const records = transform([], cost, CTX)
    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.cost_usd).toBeCloseTo(3.0)
    expect(r.tokens_used).toBe(0)
    expect(r.input_tokens).toBe(0)
    expect(r.output_tokens).toBe(0)
    expect(r.request_count).toBe(1)
  })

  test("model_name is never null", () => {
    const cost = [
      {
        starting_at: "2026-06-03T00:00:00Z",
        results: [{ amount: "1.00" }], // no model field
      },
    ]
    const records = transform([], cost, CTX)
    expect(records[0].model_name).toBe("unknown")
  })

  test("unparseable bucket is skipped", () => {
    const cost = [
      { starting_at: null, results: [{ model: "x", amount: "1" }] },
    ]
    expect(transform([], cost, CTX)).toEqual([])
  })

  test("input_tokens prefers explicit input_tokens field", () => {
    const usage = [
      {
        starting_at: "2026-06-04T00:00:00Z",
        results: [
          {
            model: "claude-sonnet-4-5",
            input_tokens: 42,
            uncached_input_tokens: 999, // ignored when input_tokens present
            output_tokens: 8,
          },
        ],
      },
    ]
    const records = transform(usage, [], CTX)
    expect(records[0].input_tokens).toBe(42)
    expect(records[0].output_tokens).toBe(8)
    expect(records[0].tokens_used).toBe(50)
  })

  test("sums input across uncached + cache creation + cache read", () => {
    const usage = [
      {
        starting_at: "2026-06-05T00:00:00Z",
        results: [
          {
            model: "claude-sonnet-4-5",
            uncached_input_tokens: 10,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 5,
            output_tokens: 0,
            request_count: 1,
          },
        ],
      },
    ]
    const records = transform(usage, [], CTX)
    expect(records[0].input_tokens).toBe(18)
  })

  test("merges multiple cost rows for same bucket+model", () => {
    const cost = [
      {
        starting_at: "2026-06-06T00:00:00Z",
        results: [
          { model: "claude-opus-4", amount: "150" }, // cents
          { model: "claude-opus-4", amount: "225" }, // cents -> sum $3.75
        ],
      },
    ]
    const records = transform([], cost, CTX)
    expect(records).toHaveLength(1)
    expect(records[0].cost_usd).toBeCloseTo(3.75)
  })
})

// ---------------------------------------------------------------------------
// Usage & Cost Analytics API (per actor / key / workspace)
// ---------------------------------------------------------------------------


const D1 = "2026-10-01T00:00:00Z"
const D2 = "2026-10-02T00:00:00Z"

/** Org totals for the fixture below, in USD. */
const ORG_DAILY_TOTAL_USD: Record<string, number> = {
  "2026-10-01": 412.8 + 12.345678 + 7.5 + 0.25,
  "2026-10-02": 100,
}

function group(actor: any, extra: Record<string, unknown> = {}) {
  return { actor, api_key_id: null, workspace_id: null, model: "claude-sonnet-4-5", ...extra }
}
const ALICE = { type: "user_actor", user_id: "user_01", email_address: "Alice@Example.com", name: "Alice", deleted: false }
const KEY = { type: "api_actor", api_key_id: "apikey_01" }
const SVC = { type: "service_account_actor", service_account_id: "svc_01" }

function analyticsCost() {
  return [
    { starting_at: D1, ending_at: D2, group: group(ALICE), cost: { amount: "41280.000000", list_amount: "50000.000000", currency: "USD", requests: 4 } },
    { starting_at: D1, ending_at: D2, group: group(KEY, { api_key_id: "apikey_01", workspace_id: "wrkspc_01" }), cost: { amount: "1234.567800", currency: "USD", requests: 2 } },
    { starting_at: D1, ending_at: D2, group: group(SVC, { workspace_id: "wrkspc_02" }), cost: { amount: "750.000000", currency: "USD", requests: 1 } },
    { starting_at: D1, ending_at: D2, group: group(null), cost: { amount: "25.000000", currency: "USD", requests: null } },
    { starting_at: D2, ending_at: "2026-10-03T00:00:00Z", group: group(ALICE, { model: "claude-opus-4-6" }), cost: { amount: "10000.000000", currency: "USD", requests: 9 } },
  ]
}

function analyticsUsage() {
  return [
    {
      starting_at: D1,
      ending_at: D2,
      group: group(ALICE),
      usage: {
        uncached_input_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 5 },
        cache_read_input_tokens: 20,
        output_tokens: 50,
        requests: 4,
      },
    },
  ]
}

function dailySums(records: { timestamp: string; cost_usd: number }[]) {
  const out: Record<string, number> = {}
  for (const r of records) out[r.timestamp.slice(0, 10)] = (out[r.timestamp.slice(0, 10)] ?? 0) + r.cost_usd
  return out
}

describe("anthropic transformAnalytics", () => {
  test("maps actor / api key / workspace into metadata.attribution", () => {
    const records = transformAnalytics(analyticsCost(), analyticsUsage(), CTX)
    expect(records).toHaveLength(5)
    const d1 = records.filter((r) => r.timestamp.startsWith("2026-10-01"))

    const alice = d1.find((r) => (r.metadata.attribution as any).person_email)!
    expect(alice.metadata.attribution).toEqual({
      granularity: "person",
      person_email: "alice@example.com",
      person_external_id: "user_01",
      person_name: "Alice",
    })
    expect(alice.cost_usd).toBeCloseTo(412.8)
    expect(alice.metadata.list_amount_usd).toBeCloseTo(500)
    expect(alice.input_tokens).toBe(135)
    expect(alice.output_tokens).toBe(50)
    expect(alice.request_count).toBe(4)
    expect(alice.model_name).toBe("claude-sonnet-4-5")
    expect(alice.metadata.source).toBe("analytics")

    const key = d1.find((r) => (r.metadata.attribution as any).api_key_id)!
    expect(key.metadata.attribution).toEqual({ granularity: "api_key", api_key_id: "apikey_01", workspace_id: "wrkspc_01" })
    expect(key.cost_usd).toBeCloseTo(12.345678)

    const svc = d1.find((r) => r.metadata.actor_type === "service_account_actor")!
    expect(svc.metadata.attribution).toEqual({ granularity: "workspace", workspace_id: "wrkspc_02" })
    expect(svc.metadata.service_account_id).toBe("svc_01")

    const unattributed = d1.find((r) => r.metadata.actor_type === null)!
    expect(unattributed.metadata.attribution).toEqual({ granularity: "org" })
    expect(unattributed.request_count).toBe(1)
  })

  test("daily sum of attributed rows equals the daily org total (no double counting)", () => {
    const sums = dailySums(transformAnalytics(analyticsCost(), analyticsUsage(), CTX))
    expect(Object.keys(sums).sort()).toEqual(Object.keys(ORG_DAILY_TOTAL_USD).sort())
    for (const [day, total] of Object.entries(ORG_DAILY_TOTAL_USD)) {
      expect(sums[day]).toBeCloseTo(total, 6)
    }
  })

  test("model_name never null and usage-only groups still emit a row", () => {
    const usageOnly = [{ starting_at: D1, group: { actor: ALICE, model: null }, usage: { uncached_input_tokens: 3, output_tokens: 1, requests: 1 } }]
    const records = transformAnalytics([], usageOnly, CTX)
    expect(records).toHaveLength(1)
    expect(records[0].model_name).toBe("unknown")
    expect(records[0].cost_usd).toBe(0)
  })

  test("legacy transform attributes workspace rows", () => {
    const cost = [
      {
        starting_at: D1,
        results: [
          { workspace_id: "wrkspc_01", amount: "500" },
          { workspace_id: null, amount: "250" },
        ],
      },
    ]
    const records = transform([], cost, CTX)
    const ws = records.find((r) => r.cost_usd === 5)!
    expect(ws.metadata.attribution).toEqual({ granularity: "workspace", workspace_id: "wrkspc_01" })
    const dflt = records.find((r) => r.cost_usd === 2.5)!
    expect(dflt.metadata.attribution).toEqual({ granularity: "org" })
  })
})

describe("anthropic collect (mocked fetch)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
  })

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  const ctx = { apiKey: "test-admin-key", userId: "user-1", providerId: "prov-anthropic" }

  test("uses the analytics API with the beta header and actor/key/workspace/model grouping", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} })
      const u = new URL(String(url))
      if (u.pathname.endsWith("/analytics/cost")) return jsonResponse({ data: analyticsCost(), has_more: false, next_page: null })
      if (u.pathname.endsWith("/analytics/usage")) return jsonResponse({ data: analyticsUsage(), has_more: false, next_page: null })
      throw new Error(`unexpected ${url}`)
    }) as any

    const records = await collector.collect(ctx)
    expect(records).toHaveLength(5)
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      const u = new URL(c.url)
      expect(c.headers["anthropic-beta"]).toBe("analytics-usage-cost-2026-08-24")
      expect(u.searchParams.getAll("group_by[]")).toEqual(ANALYTICS_GROUP_BY)
      expect(u.searchParams.get("time_bucket_width")).toBe("1d")
      expect(u.searchParams.get("limit")).toBe("1000")
      // Re-pulls today + the prior 3 days.
      const span = Date.parse(u.searchParams.get("ending_at")!) - Date.parse(u.searchParams.get("starting_at")!)
      expect(span).toBe(4 * 24 * 3600 * 1000)
    }
  })

  test("falls back to the legacy cost_report when analytics returns 404", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    const legacyCalls: string[] = []
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname.includes("/analytics/")) return jsonResponse({ error: { type: "not_found_error" } }, 404)
      legacyCalls.push(u.pathname + "?" + u.searchParams.getAll("group_by[]").join(","))
      if (u.pathname.endsWith("/cost_report")) {
        return jsonResponse({
          data: [{ starting_at: D1, results: [{ workspace_id: "wrkspc_01", amount: "1000" }] }],
          has_more: false,
        })
      }
      if (u.pathname.endsWith("/usage_report/messages")) {
        return jsonResponse({
          data: [{ starting_at: D1, results: [{ workspace_id: "wrkspc_01", uncached_input_tokens: 7, output_tokens: 3 }] }],
          has_more: false,
        })
      }
      throw new Error(`unexpected ${url}`)
    }) as any

    const records = await collector.collect(ctx)
    expect(legacyCalls.sort()).toEqual([
      "/v1/organizations/cost_report?workspace_id",
      "/v1/organizations/usage_report/messages?workspace_id",
    ])
    expect(records).toHaveLength(1)
    expect(records[0].cost_usd).toBeCloseTo(10)
    expect(records[0].tokens_used).toBe(10)
    expect(records[0].metadata.source).toBe("cost_report")
    expect(records[0].metadata.attribution).toEqual({ granularity: "workspace", workspace_id: "wrkspc_01" })
  })

  test("other analytics errors still fail the collection (no silent fallback)", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ error: "bad" }, 400)) as any
    await expect(collector.collect(ctx)).rejects.toThrow(/400/)
  })
})
