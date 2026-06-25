/**
 * Pure transform tests for the Apify collector. No network — `transform` is
 * called directly with sample dailyServiceUsages rows.
 */

import { transform } from "./apify"
import type { CostRecord } from "./types"

const ctx = { userId: "user-123", providerId: "provider-apify" }
const cycle = { start: "2026-06-19T00:00:00.000Z", end: "2026-07-18T23:59:59.999Z" }

type DailyRow = {
  date?: string
  totalUsageCreditsUsd?: number
  serviceUsage?: Record<string, { quantity?: number; baseAmountUsd?: number }>
}

function sampleDaily(): DailyRow[] {
  return [
    {
      date: "2026-06-19T00:00:00.000Z",
      totalUsageCreditsUsd: 0.0043970274542745,
      serviceUsage: {
        DATASET_TIMED_STORAGE_GBYTE_HOURS: { quantity: 5.27, baseAmountUsd: 0.0042 },
        KEY_VALUE_STORE_TIMED_STORAGE_GBYTE_HOURS: { quantity: 0.22, baseAmountUsd: 0.00017 },
      },
    },
    {
      date: "2026-06-20T12:00:00.000Z", // mid-day -> buckets to the 20th
      totalUsageCreditsUsd: 12.5,
      serviceUsage: { ACTOR_COMPUTE_UNITS: { quantity: 3, baseAmountUsd: 12.5 } },
    },
  ]
}

function byDay(records: CostRecord[]): Record<string, CostRecord> {
  const out: Record<string, CostRecord> = {}
  for (const r of records) out[r.timestamp.slice(0, 10)] = r
  return out
}

describe("apify transform", () => {
  test("one record per UTC day with totalUsageCreditsUsd as cost", () => {
    const records = transform(sampleDaily(), ctx, cycle)
    const m = byDay(records)
    expect(m["2026-06-19"].cost_usd).toBeCloseTo(0.0043970274542745)
    expect(m["2026-06-20"].cost_usd).toBeCloseTo(12.5)
  })

  test("timestamp is UTC-midnight; model_name is 'apify'", () => {
    const records = transform(sampleDaily(), ctx, cycle)
    for (const r of records) {
      expect(r.timestamp.endsWith("T00:00:00.000Z")).toBe(true)
      expect(r.model_name).toBe("apify")
      expect(r.collection_method).toBe("api_automated")
    }
  })

  test("per-service breakdown + cycle in metadata; request_count = service count", () => {
    const records = transform(sampleDaily(), ctx, cycle)
    const m = byDay(records)
    const d19 = m["2026-06-19"]
    expect(d19.request_count).toBe(2)
    expect((d19.metadata.services as Record<string, number>).DATASET_TIMED_STORAGE_GBYTE_HOURS).toBeCloseTo(0.0042)
    expect(d19.metadata.cycle_start).toBe(cycle.start)
    expect(d19.metadata.provider).toBe("apify")
  })

  test("tokens are null", () => {
    const records = transform(sampleDaily(), ctx, cycle)
    for (const r of records) {
      expect(r.tokens_used).toBeNull()
      expect(r.input_tokens).toBeNull()
      expect(r.output_tokens).toBeNull()
    }
  })

  test("skips rows with missing/unparseable date", () => {
    const rows: DailyRow[] = [
      { date: undefined, totalUsageCreditsUsd: 5 },
      { date: "not-a-date", totalUsageCreditsUsd: 5 },
      { date: "2026-06-21T00:00:00.000Z", totalUsageCreditsUsd: 1 },
    ]
    const records = transform(rows, ctx, cycle)
    expect(records.length).toBe(1)
    expect(records[0].timestamp.slice(0, 10)).toBe("2026-06-21")
  })
})
