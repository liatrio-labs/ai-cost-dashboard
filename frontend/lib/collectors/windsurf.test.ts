/**
 * Pure transform tests for the Windsurf collector. No network — `transform` is
 * called directly with sample CascadeAnalytics run rows.
 *
 * Cost is EXTRAPOLATED from messagesSent (no real $ for QUOTA billing):
 *   cost_usd = messagesSent * creditsPerMessage * usdPerCredit
 */

import { transform } from "./windsurf"
import type { CostRecord } from "./types"

const ctx = {
  userId: "user-123",
  providerId: "provider-windsurf",
  teamId: "team-9",
  usdPerCredit: 0.04,
  creditsPerMessage: 1,
}

function sampleRuns() {
  return [
    { day: "2026-05-26T00:00:00Z", model: "Claude Sonnet 4.6", mode: "DEFAULT", messagesSent: "7", cascadeId: "a" },
    { day: "2026-05-26T00:00:00Z", model: "Claude Sonnet 4.6", mode: "DEFAULT", messagesSent: "7", cascadeId: "b" },
    { day: "2026-05-26T00:00:00Z", model: "GPT-5.5", mode: "DEFAULT", messagesSent: "1", cascadeId: "c" },
    { day: "2026-05-28T00:00:00Z", model: "Claude Opus 4.8 Medium", mode: "PLANNER", messagesSent: "54", cascadeId: "d" },
  ]
}

function byKey(records: CostRecord[]): Record<string, CostRecord> {
  const out: Record<string, CostRecord> = {}
  for (const r of records) out[`${r.timestamp.slice(0, 10)}|${r.model_name}`] = r
  return out
}

describe("windsurf transform", () => {
  test("aggregates messages by day x model and extrapolates cost", () => {
    const records = transform(sampleRuns(), ctx)
    const m = byKey(records)
    // Sonnet on the 26th: 7 + 7 = 14 messages -> 14 * 0.04 = $0.56
    expect(m["2026-05-26|Claude Sonnet 4.6"].request_count).toBe(14)
    expect(m["2026-05-26|Claude Sonnet 4.6"].cost_usd).toBeCloseTo(0.56)
    // Opus on the 28th: 54 -> $2.16
    expect(m["2026-05-28|Claude Opus 4.8 Medium"].cost_usd).toBeCloseTo(2.16)
  })

  test("respects configurable rates", () => {
    const records = transform(sampleRuns(), { ...ctx, usdPerCredit: 0.1, creditsPerMessage: 2 })
    const m = byKey(records)
    // 14 messages * 2 credits * $0.10 = $2.80
    expect(m["2026-05-26|Claude Sonnet 4.6"].cost_usd).toBeCloseTo(2.8)
    expect(m["2026-05-26|Claude Sonnet 4.6"].metadata.credits_estimated).toBe(28)
  })

  test("metadata records cost basis, raw messages, rates", () => {
    const records = transform(sampleRuns(), ctx)
    const r = byKey(records)["2026-05-28|Claude Opus 4.8 Medium"]
    expect(r.metadata.cost_basis).toBe("extrapolated_from_messages")
    expect(r.metadata.messages_sent).toBe(54)
    expect(r.metadata.usd_per_credit).toBe(0.04)
    expect(r.metadata.team_id).toBe("team-9")
    expect(r.metadata.cascade_count).toBe(1)
  })

  test("timestamp UTC-midnight; tokens null; never-null model", () => {
    const records = transform(sampleRuns(), ctx)
    for (const r of records) {
      expect(r.timestamp.endsWith("T00:00:00.000Z")).toBe(true)
      expect(r.tokens_used).toBeNull()
      expect(r.model_name).not.toBeNull()
    }
    // missing model -> "windsurf"
    const fallback = transform([{ day: "2026-05-26T00:00:00Z", messagesSent: "1" }], ctx)
    expect(fallback[0].model_name).toBe("windsurf")
  })

  test("skips rows with unparseable day", () => {
    const records = transform(
      [
        { day: "nope", model: "X", messagesSent: "5" },
        { day: "2026-05-26T00:00:00Z", model: "Y", messagesSent: "5" },
      ],
      ctx
    )
    expect(records.length).toBe(1)
    expect(records[0].model_name).toBe("Y")
  })
})
