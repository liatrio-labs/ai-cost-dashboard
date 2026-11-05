/**
 * Pure transform tests for the Cursor collector. No network — `transform` is
 * called directly with sample usage-event arrays.
 *
 * The collector builds one record per (UTC day x member email x model) from
 * /teams/filtered-usage-events, carrying real chargedCents -> dollars and
 * token counts.
 */

import { CURSOR_ON_DEMAND_SINCE, cursorBillingTier, transform, withinOnDemandWindow } from "./cursor"
import type { CostRecord } from "./types"

const ctx = {
  userId: "user-123",
  providerId: "provider-cursor",
  teamId: "team-42",
}

// 2026-06-22 12:00 UTC and 2026-06-23 09:00 UTC in epoch ms.
const TS_JUN22 = Date.UTC(2026, 5, 22, 12, 0, 0)
const TS_JUN23 = Date.UTC(2026, 5, 23, 9, 0, 0)
const DAY_JUN22 = new Date(Date.UTC(2026, 5, 22)).toISOString()
const DAY_JUN23 = new Date(Date.UTC(2026, 5, 23)).toISOString()

function sampleEvents() {
  return [
    {
      timestamp: String(TS_JUN22),
      userEmail: "alice@example.com",
      model: "claude-4-sonnet",
      kind: "agent",
      isChargeable: true,
      chargedCents: 1500, // $15.00
      isTokenBasedCall: true,
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheWriteTokens: 50,
        cacheReadTokens: 80,
        totalCents: 1500,
      },
    },
    {
      // same day + member + model -> aggregates with the first event
      timestamp: String(TS_JUN22 + 60_000),
      userEmail: "alice@example.com",
      model: "claude-4-sonnet",
      kind: "chat",
      isChargeable: true,
      chargedCents: 500, // $5.00
      isTokenBasedCall: true,
      tokenUsage: {
        inputTokens: 300,
        outputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalCents: 500,
      },
    },
    {
      // alice, different day -> separate record
      timestamp: String(TS_JUN23),
      userEmail: "alice@example.com",
      model: "claude-4-sonnet",
      kind: "agent",
      isChargeable: true,
      chargedCents: 250, // $2.50
      isTokenBasedCall: true,
      tokenUsage: { inputTokens: 100, outputTokens: 20 },
    },
    {
      // bob, non-token, non-chargeable event (subscription-included)
      timestamp: String(TS_JUN22),
      userEmail: "bob@example.com",
      model: "gpt-5",
      kind: "chat",
      isChargeable: false,
      chargedCents: 0,
      isTokenBasedCall: false,
    },
  ]
}

function byKey(records: CostRecord[]): Record<string, CostRecord> {
  const out: Record<string, CostRecord> = {}
  for (const r of records) {
    out[`${r.timestamp}|${r.metadata.member_email}|${r.model_name}`] = r
  }
  return out
}

describe("cursor transform", () => {
  test("aggregates by day x member x model; cents -> dollars", () => {
    const records = transform(sampleEvents(), ctx)
    const m = byKey(records)
    const aliceJun22 = m[`${DAY_JUN22}|alice@example.com|claude-4-sonnet`]
    const aliceJun23 = m[`${DAY_JUN23}|alice@example.com|claude-4-sonnet`]
    expect(aliceJun22.cost_usd).toBeCloseTo(20.0) // 1500 + 500 cents
    expect(aliceJun23.cost_usd).toBeCloseTo(2.5)
  })

  test("token counts summed; tokens_used = input + output", () => {
    const records = transform(sampleEvents(), ctx)
    const a = byKey(records)[`${DAY_JUN22}|alice@example.com|claude-4-sonnet`]
    expect(a.input_tokens).toBe(1300) // 1000 + 300
    expect(a.output_tokens).toBe(300) // 200 + 100
    expect(a.tokens_used).toBe(1600)
    expect(a.metadata.cache_write_tokens).toBe(50)
    expect(a.metadata.cache_read_tokens).toBe(80)
  })

  test("request_count = number of events in the group", () => {
    const records = transform(sampleEvents(), ctx)
    const a = byKey(records)[`${DAY_JUN22}|alice@example.com|claude-4-sonnet`]
    expect(a.request_count).toBe(2)
    expect(a.metadata.chargeable_event_count).toBe(2)
  })

  test("model_name never null; non-token zero-cost event kept", () => {
    const records = transform(sampleEvents(), ctx)
    const bob = byKey(records)[`${DAY_JUN22}|bob@example.com|gpt-5`]
    expect(bob).toBeDefined()
    expect(bob.model_name).toBe("gpt-5")
    expect(bob.cost_usd).toBeCloseTo(0)
    expect(bob.request_count).toBe(1)
    for (const r of records) expect(r.model_name).not.toBeNull()
  })

  test("missing model falls back to 'cursor'", () => {
    const records = transform(
      [{ timestamp: String(TS_JUN22), userEmail: "x@example.com", chargedCents: 100 }],
      ctx
    )
    expect(records[0].model_name).toBe("cursor")
  })

  test("skips events with unparseable timestamp", () => {
    const records = transform(
      [
        { timestamp: "not-a-number", userEmail: "x@example.com", chargedCents: 100 },
        { timestamp: String(TS_JUN22), userEmail: "y@example.com", chargedCents: 100 },
      ],
      ctx
    )
    const emails = new Set(records.map((r) => r.metadata.member_email))
    expect(emails).toEqual(new Set(["y@example.com"]))
  })

  test("collection_method, team_id, provider, ids, timestamp", () => {
    const records = transform(sampleEvents(), ctx)
    for (const r of records) {
      expect(r.collection_method).toBe("api_automated")
      expect(r.metadata.team_id).toBe("team-42")
      expect(r.metadata.provider).toBe("cursor")
      expect(r.provider_id).toBe("provider-cursor")
      expect(r.user_id).toBe("user-123")
      expect(Number.isNaN(Date.parse(r.timestamp))).toBe(false)
      // timestamp is UTC-midnight
      expect(r.timestamp.endsWith("T00:00:00.000Z")).toBe(true)
    }
  })

  test("reconciliation: member_cycle_spend_cents annotated from spend map", () => {
    const records = transform(sampleEvents(), ctx, {
      "alice@example.com": 2250,
    })
    const a = byKey(records)[`${DAY_JUN22}|alice@example.com|claude-4-sonnet`]
    const bob = byKey(records)[`${DAY_JUN22}|bob@example.com|gpt-5`]
    expect(a.metadata.member_cycle_spend_cents).toBe(2250)
    expect(bob.metadata.member_cycle_spend_cents).toBeNull()
  })
})

describe("cursor attribution", () => {
  test("member email -> person attribution (lower-cased); missing email -> org", () => {
    const day = Date.UTC(2026, 9, 1, 12)
    const records = transform(
      [
        { timestamp: String(day), userEmail: "Dana@Liatrio.Example", model: "gpt-5", chargedCents: 120 },
        { timestamp: String(day), model: "gpt-5", chargedCents: 30 },
      ],
      { userId: "u", providerId: "p" }
    )
    const dana = records.find((r) => r.metadata.member_email === "Dana@Liatrio.Example")!
    expect(dana.metadata.attribution).toEqual({ granularity: "person", person_email: "dana@liatrio.example" })
    const anon = records.find((r) => r.metadata.member_email === "unknown")!
    expect(anon.metadata.attribution).toEqual({ granularity: "org" })
  })
})

describe("cursor billing tier (issue #73)", () => {
  const TS_NOV3 = Date.UTC(2026, 10, 3, 15, 0, 0)
  const DAY_NOV3 = new Date(Date.UTC(2026, 10, 3)).toISOString()
  const ev = (kind: string, chargedCents: number, extra: Record<string, unknown> = {}) => ({
    timestamp: String(TS_NOV3),
    userEmail: "jacob@example.com",
    model: "grok-4.7-high",
    kind,
    isChargeable: true,
    chargedCents,
    ...extra,
  })
  const total = (rs: CostRecord[]) => rs.reduce((a, r) => a + r.cost_usd, 0)

  test("Included-in-Business events are not billable: cost_usd 0, value kept as included_value_usd", () => {
    const rs = transform([ev("Included in Business", 5000), ev("Included in Business", 1234)], ctx)
    expect(rs).toHaveLength(1)
    expect(rs[0].cost_usd).toBe(0)
    expect(total(rs)).toBe(0)
    expect(rs[0].metadata.billing_tier).toBe("included")
    expect(rs[0].metadata.included_value_usd).toBeCloseTo(62.34)
    expect(rs[0].metadata.on_demand_value_usd).toBe(0)
    expect(rs[0].request_count).toBe(2)
  })

  test("Usage-based events are billable at their charged amount", () => {
    const rs = transform([ev("Usage-based", 1999), ev("Usage-based", 1)], ctx)
    expect(rs).toHaveLength(1)
    expect(rs[0].cost_usd).toBeCloseTo(20)
    expect(rs[0].metadata.billing_tier).toBe("on_demand")
    expect(rs[0].metadata.on_demand_value_usd).toBeCloseTo(20)
    expect(rs[0].metadata.included_value_usd).toBe(0)
  })

  test("a mixed day/person/model is split into one row per tier, kinds preserved", () => {
    const rs = transform([ev("Included in Business", 10000), ev("Usage-based", 250), ev("Usage-based", 50)], ctx)
    expect(rs).toHaveLength(2)
    const inc = rs.find((r) => r.metadata.billing_tier === "included")!
    const od = rs.find((r) => r.metadata.billing_tier === "on_demand")!
    for (const r of rs) {
      expect(r.timestamp).toBe(DAY_NOV3)
      expect(r.model_name).toBe("grok-4.7-high")
      expect(r.metadata.member_email).toBe("jacob@example.com")
    }
    expect(inc.metadata.kinds).toEqual(["Included in Business"])
    expect(od.metadata.kinds).toEqual(["Usage-based"])
    expect(inc.cost_usd).toBe(0)
    expect(inc.metadata.included_value_usd).toBeCloseTo(100)
    expect(od.cost_usd).toBeCloseTo(3)
    expect(total(rs)).toBeCloseTo(3) // only on-demand counts
  })

  test("billingTier field also marks the included pool", () => {
    expect(cursorBillingTier({ kind: "Usage-based" })).toBe("on_demand")
    expect(cursorBillingTier({ kind: "Included in Business" })).toBe("included")
    expect(cursorBillingTier({ kind: "Included in Pro" })).toBe("included")
    expect(cursorBillingTier({ kind: "agent", billingTier: "included" })).toBe("included")
    expect(cursorBillingTier({ kind: "Errored, Not Charged" })).toBe("on_demand")
    expect(cursorBillingTier({})).toBe("on_demand")
  })

  test("/teams/spend: spendCents (on-demand) and overallSpendCents kept apart", () => {
    const rs = transform([ev("Usage-based", 100)], ctx, {
      spendCents: { "jacob@example.com": 20000 },
      overallSpendCents: { "jacob@example.com": 700000 },
    })
    expect(rs[0].metadata.member_cycle_spend_cents).toBe(20000)
    expect(rs[0].metadata.member_cycle_overall_spend_cents).toBe(700000)
  })

  test("re-pulls never rewrite days before November 2026", () => {
    expect(CURSOR_ON_DEMAND_SINCE).toBe("2026-11-01")
    const rs = transform(
      [
        { ...ev("Usage-based", 100), timestamp: String(Date.UTC(2026, 9, 31, 23, 59)) },
        { ...ev("Usage-based", 200), timestamp: String(Date.UTC(2026, 10, 1, 0, 0)) },
        { ...ev("Usage-based", 300), timestamp: String(Date.UTC(2026, 9, 5)) },
      ],
      ctx
    )
    expect(rs.map((r) => r.timestamp.slice(0, 10)).sort()).toEqual(["2026-10-05", "2026-10-31", "2026-11-01"])
    expect(withinOnDemandWindow(rs).map((r) => r.timestamp.slice(0, 10))).toEqual(["2026-11-01"])
  })
})
