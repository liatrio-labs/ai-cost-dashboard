/**
 * Pure transform tests for the Vercel AI Gateway collector. No network.
 */

import { transform } from "./vercel-ai-gateway"
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
