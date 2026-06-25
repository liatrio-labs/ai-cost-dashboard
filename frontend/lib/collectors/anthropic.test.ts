/**
 * Unit tests for the Anthropic collector transform (pure, no network).
 *
 * Mirrors python-service/tests/test_anthropic_collector_transform.py — validates
 * the merge of Admin API usage + cost buckets into cost_records rows.
 */

import { transform } from "./anthropic"

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
          { model: "claude-sonnet-4-5", amount: "12.34", currency: "USD" },
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
    })
  })

  test("cost-only model has zero tokens and default request count", () => {
    const cost = [
      {
        starting_at: "2026-06-02T00:00:00Z",
        results: [{ model: "claude-opus-4", amount: "3.00" }],
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
          { model: "claude-opus-4", amount: "1.50" },
          { model: "claude-opus-4", amount: "2.25" },
        ],
      },
    ]
    const records = transform([], cost, CTX)
    expect(records).toHaveLength(1)
    expect(records[0].cost_usd).toBeCloseTo(3.75)
  })
})
