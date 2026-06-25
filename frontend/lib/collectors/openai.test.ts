/**
 * Unit tests for the OpenAI collector `transform` (pure, no network).
 *
 * Mirrors the Python transform_to_cost_records tests: validates the Costs
 * (authoritative USD) + Usage (tokens) merge.
 */

import { transform } from "./openai"

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
