/**
 * Current-period projection (issue #39). Fixed `now` values, hand-computed
 * expectations. November 2026: Nov 1 is a Sunday; 21 weekdays, 9 weekend days.
 */

import {
  BLEND_DAYS,
  isSeatRow,
  lastCompleteDay,
  monthRange,
  periodStatus,
  projectByKey,
  projectedChangePercent,
  projectionContext,
  projectPeriod,
  type ProjectionProvider,
  type ProjectionRow,
} from "./projection"

const NOV = monthRange("2026-11")
const A = "prov-a"
const B = "prov-b"
const MAX = "prov-claude-max"
const GPT = "prov-chatgpt"
const CURSOR = "prov-cursor"

const providers = (over: Partial<Record<string, string | null>> = {}): ProjectionProvider[] => [
  { id: A, name: "anthropic", last_collected_at: over[A] ?? null },
  { id: B, name: "openai", last_collected_at: over[B] ?? null },
  { id: MAX, name: "claude-max", last_collected_at: null },
  { id: GPT, name: "chatgpt", last_collected_at: null },
  { id: CURSOR, name: "cursor", last_collected_at: null },
]

const weekend = (d: string) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())
function days(start: string, end: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
/** One row per day at `wd` on weekdays and `we` on weekends. */
const daily = (provider_id: string, start: string, end: string, wd: number, we: number): ProjectionRow[] =>
  days(start, end).map((date) => ({ date, provider_id, model_name: "m", total_cost_usd: weekend(date) ? we : wd }))
const sum = (rows: ProjectionRow[]) => rows.reduce((s, r) => s + Number(r.total_cost_usd), 0)

describe("complete days", () => {
  const today = "2026-11-04"
  it("a day is complete once last_collected_at is after its end (UTC); today never is", () => {
    expect(lastCompleteDay("2026-11-04T08:55:00Z", today)).toBe("2026-11-03")
    expect(lastCompleteDay("2026-11-03T15:56:00Z", today)).toBe("2026-11-02") // OpenAI lag: Nov 3 partial
    expect(lastCompleteDay("2026-11-04T00:00:00Z", today)).toBe("2026-11-02") // not *after* Nov 3's end
    expect(lastCompleteDay("2026-11-04T00:00:01Z", today)).toBe("2026-11-03")
    expect(lastCompleteDay("2026-11-05T09:00:00Z", today)).toBe("2026-11-03") // capped at yesterday
    expect(lastCompleteDay(null, today)).toBe("2026-11-03") // manual providers
    expect(lastCompleteDay("garbage", today)).toBe("2026-11-03")
  })

  it("period status", () => {
    expect(periodStatus(NOV, "2026-11-04")).toBe("current")
    expect(periodStatus(NOV, "2026-11-30")).toBe("current")
    expect(periodStatus(NOV, "2026-12-01")).toBe("past")
    expect(periodStatus(NOV, "2026-10-31")).toBe("future")
  })
})

describe("usage projection: weekday-aware, blended", () => {
  it("w = 0 (first day of the month, no complete days): trailing average per day type", () => {
    const ctx = projectionContext(providers(), new Date("2026-11-01T10:00:00Z"))
    const rows = [...daily(A, "2026-10-01", "2026-10-31", 100, 20), { date: "2026-11-01", provider_id: A, total_cost_usd: 5 }]
    const p = projectPeriod(rows, NOV, ctx)!
    expect(p.completeDays).toBe(0)
    expect(p.completeThrough).toBeNull()
    expect(p.actual).toBe(5)
    // Every November day at the trailing rate; Nov 1 already logged $5 of its $20.
    expect(p.projected).toBe(21 * 100 + 9 * 20)
  })

  it("weekends are projected at the weekend rate, not the weekday rate", () => {
    const ctx = projectionContext(providers(), new Date("2026-11-01T10:00:00Z"))
    const flat = projectPeriod(daily(A, "2026-10-01", "2026-10-31", 60, 60), NOV, ctx)!.projected
    const split = projectPeriod(daily(A, "2026-10-01", "2026-10-31", 100, 20), NOV, ctx)!.projected
    expect(flat).toBe(30 * 60)
    expect(split).toBe(2280)
  })

  it("w = 3/14 after 3 complete days (Sun, Mon, Tue)", () => {
    const ctx = projectionContext(providers({ [A]: "2026-11-04T08:55:00Z" }), new Date("2026-11-04T10:00:00Z"))
    const rows = [
      ...daily(A, "2026-10-01", "2026-10-31", 100, 20),
      ...daily(A, "2026-11-01", "2026-11-03", 200, 40),
    ]
    const p = projectPeriod(rows, NOV, ctx)!
    expect(p.completeDays).toBe(3)
    expect(p.completeThrough).toBe("2026-11-03")
    // Trailing 28 days = Oct 7 - Nov 3: 20 weekdays (18 x 100 + 2 x 200), 8 weekend days (7 x 20 + 40).
    const trailWd = (18 * 100 + 2 * 200) / 20
    const trailWe = (7 * 20 + 40) / 8
    const w = 3 / BLEND_DAYS
    const wd = w * 200 + (1 - w) * trailWd
    const we = w * 40 + (1 - w) * trailWe
    // Nov 4-30: 19 weekdays, 8 weekend days.
    expect(p.projected).toBeCloseTo(440 + 19 * wd + 8 * we, 2)
  })

  it("w = 1 at 14 or more complete days: the month's own rates", () => {
    const ctx = projectionContext(providers(), new Date("2026-11-20T10:00:00Z"))
    const rows = [...daily(A, "2026-10-01", "2026-10-31", 100, 20), ...daily(A, "2026-11-01", "2026-11-19", 300, 60)]
    const p = projectPeriod(rows, NOV, ctx)!
    expect(p.completeDays).toBe(19)
    expect(p.projected).toBe(21 * 300 + 9 * 60)
  })

  it("an incomplete day adds only what it hasn't logged yet, never negative", () => {
    const ctx = projectionContext(providers({ [A]: "2026-11-04T08:55:00Z" }), new Date("2026-11-04T10:00:00Z"))
    const base = [...daily(A, "2026-10-01", "2026-10-31", 100, 100), ...daily(A, "2026-11-01", "2026-11-03", 100, 100)]
    expect(projectPeriod([...base, { date: "2026-11-04", provider_id: A, total_cost_usd: 30 }], NOV, ctx)!.projected).toBe(3000)
    // Today already above the expected $100: counts as logged, adds nothing.
    expect(projectPeriod([...base, { date: "2026-11-04", provider_id: A, total_cost_usd: 250 }], NOV, ctx)!.projected).toBe(3150)
  })

  it("per-provider lag: OpenAI complete through Nov 2 while others are through Nov 3", () => {
    const ctx = projectionContext(providers({ [A]: "2026-11-04T08:55:00Z", [B]: "2026-11-03T15:56:00Z" }), new Date("2026-11-04T10:00:00Z"))
    expect(ctx.completeThrough[A]).toBe("2026-11-03")
    expect(ctx.completeThrough[B]).toBe("2026-11-02")
    const rows = [
      ...daily(A, "2026-10-01", "2026-11-03", 100, 20),
      ...daily(B, "2026-10-01", "2026-11-02", 100, 20),
      { date: "2026-11-03", provider_id: B, total_cost_usd: 50 }, // half a Tuesday collected
    ]
    const p = projectPeriod(rows, NOV, ctx)!
    // Both project the full month at their rates; B's partial Nov 3 is topped up, not taken as the rate.
    expect(p.projected).toBe(2 * 2280)
    expect(p.completeDays).toBe(2)
    expect(p.completeThrough).toBe("2026-11-02")
    // Treating B's partial day as complete would under-project.
    const naive = projectionContext(providers({ [A]: "2026-11-04T08:55:00Z", [B]: "2026-11-04T08:55:00Z" }), new Date("2026-11-04T10:00:00Z"))
    expect(projectPeriod(rows, NOV, naive)!.projected).toBeLessThan(p.projected)
  })
})

describe("seats", () => {
  const ctx = projectionContext(providers({ [A]: "2026-11-04T08:55:00Z" }), new Date("2026-11-04T10:00:00Z"))
  const seat = (provider_id: string, date: string, cost: number, model_name = "seats"): ProjectionRow => ({ date, provider_id, model_name, total_cost_usd: cost })

  it("classifies monthly-seat rows on the 1st as seats", () => {
    expect(isSeatRow(seat(MAX, "2026-11-01", 200), ctx)).toBe(true)
    expect(isSeatRow(seat(GPT, "2026-11-01", 900, "chatgpt-business"), ctx)).toBe(true)
    expect(isSeatRow(seat(CURSOR, "2026-11-01", 40), ctx)).toBe(true) // 'seats' model on any provider
    expect(isSeatRow(seat(CURSOR, "2026-11-01", 40, "cursor-auto"), ctx)).toBe(false)
    expect(isSeatRow(seat(MAX, "2026-11-02", 200), ctx)).toBe(false)
  })

  it("a seat-only entity projects to its seat amount, with no run-rate", () => {
    const rows = [seat(MAX, "2026-10-01", 200), seat(MAX, "2026-11-01", 200)]
    const p = projectPeriod(rows, NOV, ctx)!
    expect(p).toMatchObject({ actual: 200, projected: 200, seatActual: 200, seatProjected: 200, usageProjected: 0 })
  })

  it("a seat billed last month but not yet this month is projected at last month's amount", () => {
    const rows = [seat(GPT, "2026-10-01", 900, "chatgpt-business"), seat(MAX, "2026-10-01", 400), seat(MAX, "2026-11-01", 600)]
    const p = projectPeriod(rows, NOV, ctx)!
    expect(p.actual).toBe(600)
    expect(p.seatProjected).toBe(600 + 900)
    expect(p.projected).toBe(1500)
  })

  it("seat rows don't feed the usage rate", () => {
    const usage = daily(A, "2026-10-01", "2026-11-03", 100, 100)
    const withSeats = [...usage, seat(MAX, "2026-10-01", 5000), seat(MAX, "2026-11-01", 5000)]
    expect(projectPeriod(withSeats, NOV, ctx)!.projected).toBe(projectPeriod(usage, NOV, ctx)!.projected + 5000)
  })
})

describe("edge cases", () => {
  const ctx = projectionContext(providers({ [A]: "2026-11-04T08:55:00Z" }), new Date("2026-11-04T10:00:00Z"))

  it("a new person (no previous full month): projected spend, trend 'new' (null), not +100% or Infinity", () => {
    const rows: ProjectionRow[] = [
      { date: "2026-11-02", provider_id: A, total_cost_usd: 80 },
      { date: "2026-11-03", provider_id: A, total_cost_usd: 80 },
    ]
    const p = projectPeriod(rows, NOV, ctx)!
    expect(p.actual).toBe(160)
    expect(p.projected).toBeGreaterThan(160)
    expect(Number.isFinite(p.projected)).toBe(true)
    expect(projectedChangePercent(p.projected, 0)).toBeNull()
  })

  it("zero history: projected = actual to date, no NaN", () => {
    expect(projectPeriod([], NOV, ctx)).toMatchObject({ actual: 0, projected: 0 })
    const today = projectPeriod([{ date: "2026-11-04", provider_id: A, total_cost_usd: 12.5 }], NOV, ctx)!
    expect(today).toMatchObject({ actual: 12.5, projected: 12.5 })
    const zeros = projectPeriod(daily(A, "2026-10-01", "2026-11-03", 0, 0), NOV, ctx)!
    expect(zeros.projected).toBe(0)
    expect(projectedChangePercent(0, 0)).toBeNull()
    expect(projectedChangePercent(NaN, 10)).toBeNull()
  })

  it("future and past periods are not projected", () => {
    expect(projectPeriod(daily(A, "2026-10-01", "2026-11-03", 1, 1), monthRange("2026-12"), ctx)).toBeNull()
    expect(projectPeriod(daily(A, "2026-10-01", "2026-11-03", 1, 1), monthRange("2026-10"), ctx)).toBeNull()
    expect(projectPeriod([], { start: "2026-12-01", end: "2026-12-31" }, ctx)).toBeNull()
    expect(projectByKey(daily(A, "2026-10-01", "2026-11-03", 1, 1), () => "k", monthRange("2026-12"), ctx).size).toBe(0)
  })

  it("a range that ends in the future projects only its remaining days", () => {
    const rows = daily(A, "2026-10-01", "2026-11-03", 100, 100)
    const p = projectPeriod(rows, { start: "2026-10-20", end: "2026-11-10" }, ctx)!
    // Oct 20 - Nov 3 actual (15 days), Nov 4 - 10 projected (7 days).
    expect(p.actual).toBe(1500)
    expect(p.projected).toBe(2200)
  })

  it("projectByKey matches projectPeriod per key", () => {
    const rows = [
      ...daily(A, "2026-10-01", "2026-11-03", 100, 20).map((r) => ({ ...r, who: "x" })),
      ...daily(A, "2026-10-01", "2026-11-03", 10, 2).map((r) => ({ ...r, who: "y" })),
    ]
    const m = projectByKey(rows, (r) => r.who, NOV, ctx)
    expect(m.get("x")).toEqual(projectPeriod(rows.filter((r) => r.who === "x"), NOV, ctx))
    expect(m.get("y")!.projected).toBeCloseTo(m.get("x")!.projected / 10, 1)
    expect(sum(rows.filter((r) => r.date >= "2026-11-01"))).toBeCloseTo(m.get("x")!.actual + m.get("y")!.actual, 6)
  })
})
