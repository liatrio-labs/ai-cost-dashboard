/**
 * Pure transform tests for the Cursor collector (mirrors the Python
 * test_cursor_collector.py suite). No network — `transform` is called directly
 * with sample arrays.
 */

import { transform } from "./cursor"
import type { CostRecord } from "./types"

const ctx = {
  userId: "user-123",
  providerId: "provider-cursor",
  teamId: "team-42",
}

const period = {
  start: "2026-06-01T00:00:00.000Z",
  end: "2026-06-24T00:00:00.000Z",
}

function sampleUsage() {
  return [
    {
      userId: 1,
      day: "2026-06-22",
      date: 1750550400000,
      email: "alice@example.com",
      isActive: true,
      chatRequests: 5,
      composerRequests: 2,
      agentRequests: 1,
      cmdkUsages: 1,
      mostUsedModel: "claude-4-sonnet",
    },
    {
      userId: 1,
      day: "2026-06-23",
      date: 1750636800000,
      email: "alice@example.com",
      isActive: true,
      chatRequests: 3,
      composerRequests: 0,
      agentRequests: 0,
      cmdkUsages: 0,
      mostUsedModel: "claude-4-sonnet",
    },
  ]
}

function sampleSpend() {
  return [
    {
      userId: 1,
      name: "Alice",
      email: "alice@example.com",
      role: "member",
      spendCents: 4250, // -> $42.50
      overallSpendCents: 4250,
      fastPremiumRequests: 100,
    },
    {
      userId: 2,
      name: "Bob",
      email: "bob@example.com",
      role: "member",
      spendCents: 0, // -> $0.00, no usage rows
      overallSpendCents: 0,
      fastPremiumRequests: 7,
    },
  ]
}

function byEmail(records: CostRecord[]): Record<string, CostRecord> {
  const out: Record<string, CostRecord> = {}
  for (const r of records) {
    out[r.metadata.member_email as string] = r
  }
  return out
}

describe("cursor transform", () => {
  test("cents to dollars", () => {
    const records = transform(sampleSpend(), sampleUsage(), ctx, period)
    const m = byEmail(records)
    expect(m["alice@example.com"].cost_usd).toBeCloseTo(42.5)
    expect(m["bob@example.com"].cost_usd).toBeCloseTo(0.0)
  })

  test("model_name never null", () => {
    const records = transform(sampleSpend(), sampleUsage(), ctx, period)
    const m = byEmail(records)
    // Alice has a model from usage rows.
    expect(m["alice@example.com"].model_name).toBe("claude-4-sonnet")
    // Bob has no usage rows -> falls back to "cursor", never null.
    expect(m["bob@example.com"].model_name).toBe("cursor")
    for (const r of records) {
      expect(r.model_name).not.toBeNull()
    }
  })

  test("member_email in metadata", () => {
    const records = transform(sampleSpend(), sampleUsage(), ctx, period)
    const emails = new Set(records.map((r) => r.metadata.member_email))
    expect(emails).toEqual(
      new Set(["alice@example.com", "bob@example.com"])
    )
  })

  test("collection_method, team_id, provider, ids", () => {
    const records = transform(sampleSpend(), sampleUsage(), ctx, period)
    for (const r of records) {
      expect(r.collection_method).toBe("api_automated")
      expect(r.metadata.team_id).toBe("team-42")
      expect(r.metadata.provider).toBe("cursor")
      expect(r.provider_id).toBe("provider-cursor")
      expect(r.user_id).toBe("user-123")
    }
  })

  test("request_count aggregated from usage", () => {
    const records = transform(sampleSpend(), sampleUsage(), ctx, period)
    const m = byEmail(records)
    // Alice: day1 (5+2+1+1=9) + day2 (3) = 12
    expect(m["alice@example.com"].request_count).toBe(12)
    // Bob: no usage -> falls back to fastPremiumRequests (7)
    expect(m["bob@example.com"].request_count).toBe(7)
  })

  test("token fields are null", () => {
    const records = transform(sampleSpend(), sampleUsage(), ctx, period)
    for (const r of records) {
      expect(r.tokens_used).toBeNull()
      expect(r.input_tokens).toBeNull()
      expect(r.output_tokens).toBeNull()
    }
  })

  test("timestamp is ISO and period metadata recorded", () => {
    const records = transform(sampleSpend(), [], ctx, period)
    for (const r of records) {
      // Parses back as a valid date.
      expect(Number.isNaN(Date.parse(r.timestamp))).toBe(false)
      expect(r.metadata.period_start).toBe(period.start)
      expect(r.metadata.period_end).toBe(period.end)
    }
  })

  test("falls back to overallSpendCents", () => {
    const spend = [
      {
        email: "carol@example.com",
        overallSpendCents: 999, // spendCents missing
        fastPremiumRequests: 1,
      },
    ]
    const records = transform(spend, [], ctx, period)
    expect(records[0].cost_usd).toBeCloseTo(9.99)
  })

  test("skips unparseable spend row", () => {
    const spend = [
      { email: "bad@example.com", spendCents: "not-a-number" },
      { email: "good@example.com", spendCents: 100 },
    ]
    const records = transform(spend, [], ctx, period)
    const emails = new Set(records.map((r) => r.metadata.member_email))
    expect(emails).toEqual(new Set(["good@example.com"]))
    expect(records[0].cost_usd).toBeCloseTo(1.0)
  })

  test("missing request count defaults to one", () => {
    const spend = [{ email: "dave@example.com", spendCents: 500 }] // no fastPremiumRequests
    const records = transform(spend, [], ctx, period)
    expect(records[0].request_count).toBe(1)
  })
})
