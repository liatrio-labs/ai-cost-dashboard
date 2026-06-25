/**
 * Unit tests for the Vercel collector transform().
 *
 * These tests are pure: no network. We feed sample FOCUS v1.3 billing-charge
 * objects (matching the verified Vercel /v1/billing/charges schema) into
 * transform() and assert the emitted cost_records shape. Mirrors the Python
 * test_vercel_collector.py transform tests.
 */

import { transform, parseJsonl } from "./vercel"

const CTX = {
  userId: "test-user-123",
  providerId: "vercel-provider-1",
  teamId: "team_abc123",
}

// Sample FOCUS v1.3 charge records as returned (one per JSONL line) by
// GET /v1/billing/charges.
const SAMPLE_CHARGES: any[] = [
  {
    BilledCost: 12.34,
    EffectiveCost: 10.0,
    BillingCurrency: "USD",
    ChargeCategory: "Usage",
    ChargePeriodStart: "2026-06-23T00:00:00Z",
    ChargePeriodEnd: "2026-06-24T00:00:00Z",
    ConsumedQuantity: 1234.5,
    ConsumedUnit: "GB",
    ServiceName: "Edge Functions",
    ServiceCategory: "Compute",
    ServiceProviderName: "Vercel",
    PricingQuantity: 1234.5,
    PricingUnit: "GB",
    Tags: { ProjectId: "prj_1", ProjectName: "my-app" },
  },
  {
    // A charge with no consumable quantity (e.g. a Tax row) and missing
    // ServiceName — exercises defensive fallbacks.
    BilledCost: 0.99,
    BillingCurrency: "USD",
    ChargeCategory: "Tax",
    ChargePeriodStart: "2026-06-23T00:00:00Z",
    ChargePeriodEnd: "2026-06-24T00:00:00Z",
    ConsumedQuantity: null,
    ConsumedUnit: null,
    ServiceCategory: "Other",
  },
]

describe("vercel transform", () => {
  it("returns one record per charge", () => {
    const records = transform(SAMPLE_CHARGES, CTX)
    expect(records).toHaveLength(SAMPLE_CHARGES.length)
  })

  it("model_name is never null and is a non-empty string", () => {
    const records = transform(SAMPLE_CHARGES, CTX)
    for (const r of records) {
      expect(r.model_name).not.toBeNull()
      expect(typeof r.model_name).toBe("string")
      expect(r.model_name).not.toBe("")
    }
    // First charge uses ServiceName; second falls back to ServiceCategory.
    expect(records[0].model_name).toBe("Edge Functions")
    expect(records[1].model_name).toBe("Other")
  })

  it("model_name falls back to 'vercel' when no service fields present", () => {
    const records = transform(
      [{ BilledCost: 1.0, ChargePeriodStart: "2026-06-23T00:00:00Z" }],
      CTX
    )
    expect(records[0].model_name).toBe("vercel")
  })

  it("collection_method is api_automated", () => {
    const records = transform(SAMPLE_CHARGES, CTX)
    for (const r of records) {
      expect(r.collection_method).toBe("api_automated")
    }
  })

  it("cost_usd is a number from BilledCost", () => {
    const records = transform(SAMPLE_CHARGES, CTX)
    for (const r of records) {
      expect(typeof r.cost_usd).toBe("number")
    }
    expect(records[0].cost_usd).toBe(12.34)
    expect(records[1].cost_usd).toBe(0.99)
  })

  it("falls back to EffectiveCost when BilledCost is absent", () => {
    const records = transform(
      [
        {
          EffectiveCost: 5.5,
          ServiceName: "Blob",
          ChargePeriodStart: "2026-06-23T00:00:00Z",
        },
      ],
      CTX
    )
    expect(records[0].cost_usd).toBe(5.5)
    expect(records[0].metadata.cost_known).toBe(true)
  })

  it("metadata carries team_id and a boolean cost_known", () => {
    const records = transform(SAMPLE_CHARGES, CTX)
    for (const r of records) {
      expect(r.metadata.team_id).toBe("team_abc123")
      expect(r.metadata).toHaveProperty("cost_known")
      expect(typeof r.metadata.cost_known).toBe("boolean")
    }
    // Both sample charges have a numeric BilledCost -> cost is known.
    expect(records[0].metadata.cost_known).toBe(true)
    expect(records[1].metadata.cost_known).toBe(true)
  })

  it("skips charges with no billed cost (zero-cost usage line items)", () => {
    const records = transform(
      [{ ServiceName: "Blob", ChargePeriodStart: "2026-06-23T00:00:00Z" }],
      CTX
    )
    expect(records).toHaveLength(0)
  })

  it("token fields are null and request_count defaults to 1", () => {
    const records = transform(SAMPLE_CHARGES, CTX)
    for (const r of records) {
      expect(r.tokens_used).toBeNull()
      expect(r.input_tokens).toBeNull()
      expect(r.output_tokens).toBeNull()
      expect(r.request_count).toBe(1)
    }
  })

  it("metadata carries provider, quantity, unit and project info", () => {
    const records = transform(SAMPLE_CHARGES, CTX)
    expect(records[0].metadata.provider).toBe("vercel")
    expect(records[0].metadata.quantity).toBe(1234.5)
    expect(records[0].metadata.unit).toBe("GB")
    expect(records[0].metadata.project_name).toBe("my-app")
  })

  it("timestamp is a tz-aware ISO 8601 string", () => {
    const records = transform(SAMPLE_CHARGES, CTX)
    for (const r of records) {
      const parsed = new Date(r.timestamp)
      expect(Number.isNaN(parsed.getTime())).toBe(false)
      // toISOString output is UTC (trailing Z).
      expect(r.timestamp).toMatch(/Z$/)
    }
  })

  it("user_id and provider_id come from ctx", () => {
    const records = transform(SAMPLE_CHARGES, CTX)
    for (const r of records) {
      expect(r.user_id).toBe("test-user-123")
      expect(r.provider_id).toBe("vercel-provider-1")
    }
  })
})

describe("vercel parseJsonl", () => {
  it("parses one object per line and skips blank/unparseable lines", () => {
    const body = [
      '{"BilledCost": 1.0, "ServiceName": "A"}',
      "",
      "   ",
      "{not valid json}",
      '{"BilledCost": 2.0, "ServiceName": "B"}',
    ].join("\n")
    const records = parseJsonl(body)
    expect(records).toHaveLength(2)
    expect(records[0].ServiceName).toBe("A")
    expect(records[1].ServiceName).toBe("B")
  })

  it("skips non-object JSON lines (arrays/scalars)", () => {
    const body = ["[1,2,3]", "42", '"hello"', '{"ok": true}'].join("\n")
    const records = parseJsonl(body)
    expect(records).toHaveLength(1)
    expect(records[0].ok).toBe(true)
  })
})
