import { findCoverageGaps, coverageWindow, type DailyTotal } from "./coverage"

const AS_OF = new Date("2026-11-03T15:30:00Z") // window: 2026-10-27 .. 2026-11-02

/** `n` consecutive days of `total` ending on (and including) `lastDay`. */
function series(provider: string, lastDay: string, n: number, total: number): DailyTotal[] {
  const end = Date.parse(`${lastDay}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => ({
    provider,
    date: new Date(end - (n - 1 - i) * 86400000).toISOString().slice(0, 10),
    total,
  }))
}

describe("findCoverageGaps", () => {
  test("window is the 7 complete UTC days before asOf (today excluded)", () => {
    expect(coverageWindow(7, AS_OF)).toEqual([
      "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02",
    ])
  })

  test("normal days are not flagged", () => {
    expect(findCoverageGaps(series("anthropic", "2026-11-03", 30, 100), { asOf: AS_OF })).toEqual([])
  })

  test("a missing day is flagged", () => {
    const rows = series("anthropic", "2026-11-02", 30, 100).filter((r) => r.date !== "2026-10-30")
    expect(findCoverageGaps(rows, { asOf: AS_OF })).toEqual([
      { provider: "anthropic", date: "2026-10-30", reason: "missing", total: null, median: 100, threshold: 25 },
    ])
  })

  test("a day below fraction x trailing median is flagged; one at/above it is not", () => {
    const rows = series("openai", "2026-11-02", 30, 100).map((r) =>
      r.date === "2026-10-29" ? { ...r, total: 24.99 } : r.date === "2026-10-31" ? { ...r, total: 25 } : r
    )
    expect(findCoverageGaps(rows, { asOf: AS_OF })).toEqual([
      { provider: "openai", date: "2026-10-29", reason: "low", total: 24.99, median: 100, threshold: 25 },
    ])
  })

  test("fraction and trailingWindow are configurable", () => {
    const rows = series("openai", "2026-11-02", 30, 100).map((r) => (r.date === "2026-11-01" ? { ...r, total: 40 } : r))
    expect(findCoverageGaps(rows, { asOf: AS_OF })).toEqual([])
    expect(findCoverageGaps(rows, { asOf: AS_OF, fraction: 0.5, trailingWindow: 3 }).map((g) => g.date)).toEqual(["2026-11-01"])
  })

  test("zero-median providers are ignored", () => {
    const rows = series("windsurf", "2026-11-02", 30, 0).filter((r) => r.date !== "2026-10-30")
    expect(findCoverageGaps(rows, { asOf: AS_OF })).toEqual([])
  })

  test("days with no history are ignored (new provider)", () => {
    // First row ever is 2026-11-01: earlier window days have no history, and
    // 11-02 is compared against a one-day history.
    const rows: DailyTotal[] = [{ provider: "cursor", date: "2026-11-01", total: 10 }]
    expect(findCoverageGaps(rows, { asOf: AS_OF })).toEqual([
      { provider: "cursor", date: "2026-11-02", reason: "missing", total: null, median: 10, threshold: 2.5 },
    ])
  })

  test("missing days do not drag the median down, and per-model rows are summed per day", () => {
    const rows = [
      ...series("anthropic", "2026-11-02", 30, 60),
      ...series("anthropic", "2026-11-02", 30, 40), // a second model on the same days
    ].filter((r) => !(r.date >= "2026-10-20" && r.date <= "2026-10-26"))
    // Days 10-27..11-02 total 100; their trailing medians ignore the 7-day hole.
    expect(findCoverageGaps(rows, { asOf: AS_OF })).toEqual([])
  })

  test("providers are evaluated independently", () => {
    const rows = [
      ...series("anthropic", "2026-11-02", 30, 100),
      ...series("openai", "2026-11-02", 30, 10).filter((r) => r.date !== "2026-11-02"),
    ]
    expect(findCoverageGaps(rows, { asOf: AS_OF }).map((g) => `${g.provider}:${g.date}:${g.reason}`)).toEqual([
      "openai:2026-11-02:missing",
    ])
  })
})
