/**
 * Pure tests for the Windsurf collector. No network.
 *
 * Cost basis is the SEAT SUBSCRIPTION (QUOTA plan, zero overage): each day
 * carries seats x $/seat / daysInMonth. CascadeAnalytics messages are usage
 * enrichment in metadata, not cost.
 */

import { aggregateRuns, buildRecords } from "./windsurf"
import type { CostRecord } from "./types"

const ctx = {
  userId: "user-123",
  providerId: "provider-windsurf",
  teamId: "team-9",
  seats: 18,
  usdPerSeat: 40,
}

function byDay(records: CostRecord[]): Record<string, CostRecord> {
  const out: Record<string, CostRecord> = {}
  for (const r of records) out[r.timestamp.slice(0, 10)] = r
  return out
}

describe("windsurf aggregateRuns", () => {
  test("aggregates messages per day and per model", () => {
    const runs = [
      { day: "2026-05-26T00:00:00Z", model: "Claude Sonnet 4.6", messagesSent: "7" },
      { day: "2026-05-26T00:00:00Z", model: "Claude Sonnet 4.6", messagesSent: "7" },
      { day: "2026-05-26T00:00:00Z", model: "GPT-5.5", messagesSent: "1" },
      { day: "2026-05-28T00:00:00Z", model: "Claude Opus 4.8 Medium", messagesSent: "54" },
    ]
    const u = aggregateRuns(runs)
    expect(u["2026-05-26T00:00:00.000Z"].messages).toBe(15)
    expect(u["2026-05-26T00:00:00.000Z"].models["Claude Sonnet 4.6"]).toBe(14)
    expect(u["2026-05-28T00:00:00.000Z"].messages).toBe(54)
  })

  test("skips rows with unparseable day", () => {
    const u = aggregateRuns([{ day: "nope", messagesSent: "5" }])
    expect(Object.keys(u).length).toBe(0)
  })
})

describe("windsurf buildRecords (seat subscription)", () => {
  const days = [
    "2026-05-30T00:00:00.000Z", // May has 31 days
    "2026-05-31T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z", // June has 30 days
  ]
  const usage = {
    "2026-05-31T00:00:00.000Z": { messages: 15, models: { "Claude Sonnet 4.6": 14, "GPT-5.5": 1 } },
  }

  test("daily cost = seats * usdPerSeat / daysInMonth", () => {
    const records = byDay(buildRecords(days, usage, ctx))
    // May: 18*40/31 = 23.2258...
    expect(records["2026-05-30"].cost_usd).toBeCloseTo((18 * 40) / 31)
    // June: 18*40/30 = 24
    expect(records["2026-06-01"].cost_usd).toBeCloseTo(24)
  })

  test("a full calendar month of days sums to seats * usdPerSeat", () => {
    const juneDays = Array.from({ length: 30 }, (_, i) =>
      new Date(Date.UTC(2026, 5, i + 1)).toISOString()
    )
    const records = buildRecords(juneDays, {}, ctx)
    const total = records.reduce((s, r) => s + r.cost_usd, 0)
    expect(total).toBeCloseTo(18 * 40) // $720
  })

  test("usage attached as metadata; cost_basis is seat_subscription", () => {
    const r = byDay(buildRecords(days, usage, ctx))["2026-05-31"]
    expect(r.metadata.cost_basis).toBe("seat_subscription")
    expect(r.metadata.seats).toBe(18)
    expect(r.metadata.usd_per_seat).toBe(40)
    expect(r.metadata.messages_sent).toBe(15)
    expect((r.metadata.models as Record<string, number>)["Claude Sonnet 4.6"]).toBe(14)
    expect(r.request_count).toBe(15)
  })

  test("idle day (no usage) still bills subscription with request_count 1", () => {
    const r = byDay(buildRecords(days, usage, ctx))["2026-05-30"]
    expect(r.metadata.messages_sent).toBe(0)
    expect(r.request_count).toBe(1)
    expect(r.cost_usd).toBeGreaterThan(0)
  })

  test("every record: model 'windsurf', UTC-midnight, tokens null", () => {
    for (const r of buildRecords(days, usage, ctx)) {
      expect(r.model_name).toBe("windsurf")
      expect(r.timestamp.endsWith("T00:00:00.000Z")).toBe(true)
      expect(r.tokens_used).toBeNull()
      expect(r.collection_method).toBe("api_automated")
    }
  })
})
