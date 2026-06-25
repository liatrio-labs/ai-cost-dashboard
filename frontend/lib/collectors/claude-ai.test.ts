/**
 * Unit tests for the Claude Enterprise Analytics transform.
 *
 * Mirror of python-service/tests/test_claude_ai_analytics_collector.py. These
 * exercise the pure `transform` function only — no network. Confirms the
 * cents->USD division (by 100), model_name never null, token aggregation, null
 * tokens when usage is absent, and that bad buckets/results are skipped.
 */

import { transform } from "./claude-ai"

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
          output_tokens: 500,
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
    expect(sonnet.request_count).toBe(1)
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
    // uncached (1000) + cache_read (200) = 1200 input
    expect(sonnet.input_tokens).toBe(1200)
    expect(sonnet.output_tokens).toBe(500)
    expect(sonnet.tokens_used).toBe(1700)
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
