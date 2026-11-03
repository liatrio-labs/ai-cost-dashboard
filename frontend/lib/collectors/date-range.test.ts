import { resolveDateRange, parseIsoDay, earliestDataMs, MAX_RANGE_DAYS } from "./date-range"

const NOW = new Date("2026-11-03T15:30:00Z")
const DAY = 24 * 3600 * 1000

function ok(provider: string, s: unknown, e: unknown) {
  const r = resolveDateRange(provider, s, e, NOW)
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.range
}
function err(provider: string, s: unknown, e: unknown) {
  const r = resolveDateRange(provider, s, e, NOW)
  if (r.ok) throw new Error("expected an error")
  return r.error
}

describe("resolveDateRange", () => {
  test("both absent -> no range (existing behaviour)", () => {
    expect(ok("anthropic", undefined, undefined)).toBeNull()
    expect(ok("anthropic", null, "")).toBeNull()
    // Non-range providers are fine without dates.
    expect(ok("cursor", undefined, undefined)).toBeNull()
  })

  test("missing one date", () => {
    expect(err("anthropic", "2026-03-01", undefined)).toMatch(/together/)
    expect(err("anthropic", undefined, "2026-03-01")).toMatch(/together/)
  })

  test("bad format or impossible date", () => {
    expect(err("anthropic", "2026-3-01", "2026-03-05")).toMatch(/start_date.*YYYY-MM-DD/)
    expect(err("anthropic", "2026-03-01", "03/05/2026")).toMatch(/end_date.*YYYY-MM-DD/)
    expect(err("anthropic", "2026-02-30", "2026-03-05")).toMatch(/start_date/)
    expect(err("anthropic", 20260301, "2026-03-05")).toMatch(/start_date/)
    expect(err("anthropic", "2026-03-01T00:00:00Z", "2026-03-05")).toMatch(/start_date/)
  })

  test("reversed", () => {
    expect(err("openai", "2026-03-10", "2026-03-01")).toMatch(/on or before/)
  })

  test("span limit is 31 days inclusive", () => {
    const r = ok("anthropic", "2026-03-01", "2026-03-31")!
    expect(r.end.getTime() - r.start.getTime()).toBe(MAX_RANGE_DAYS * DAY)
    expect(err("anthropic", "2026-03-01", "2026-04-01")).toMatch(/32 days.*maximum is 31/)
  })

  test("future end_date rejected; today allowed", () => {
    expect(err("anthropic", "2026-11-01", "2026-11-04")).toMatch(/after today/)
    const r = ok("anthropic", "2026-11-01", "2026-11-03")!
    expect(r.end.toISOString()).toBe("2026-11-04T00:00:00.000Z")
  })

  test("unsupported provider", () => {
    expect(err("cursor", "2026-03-01", "2026-03-02")).toMatch(/does not support.*anthropic, claude-ai, openai, vercel-ai-gateway/)
  })

  test("valid range -> [start, end + 1 day)", () => {
    const r = ok("claude-ai", "2026-01-24", "2026-01-31")!
    expect(r).toMatchObject({
      start_date: "2026-01-24",
      end_date: "2026-01-31",
      requested_start_date: "2026-01-24",
      clamped: false,
    })
    expect(r.start.toISOString()).toBe("2026-01-24T00:00:00.000Z")
    expect(r.end.toISOString()).toBe("2026-02-01T00:00:00.000Z")
  })

  test("clamps start before 2026-01-01 for anthropic and claude-ai and reports it", () => {
    for (const p of ["anthropic", "claude-ai"]) {
      const r = ok(p, "2025-12-15", "2026-01-10")!
      expect(r.start_date).toBe("2026-01-01")
      expect(r.requested_start_date).toBe("2025-12-15")
      expect(r.clamped).toBe(true)
      expect(r.start.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    }
    expect(err("anthropic", "2025-12-01", "2025-12-31")).toMatch(/earliest data.*2026-01-01/)
  })

  test("openai clamps to MAX_HISTORICAL_DAYS before today", () => {
    const earliest = earliestDataMs("openai", NOW)
    expect(new Date(earliest).toISOString()).toBe("2025-11-02T00:00:00.000Z")
    const r = ok("openai", "2025-10-20", "2025-11-10")!
    expect(r.start_date).toBe("2025-11-02")
    expect(r.clamped).toBe(true)
    // 2025-12-15 is before Anthropic's floor but within OpenAI's window.
    expect(ok("openai", "2025-12-15", "2025-12-20")!.clamped).toBe(false)
  })
})

describe("resolveDateRange: vercel-ai-gateway (issue #28)", () => {
  test("accepts a range and never clamps it", () => {
    const r = ok("vercel-ai-gateway", "2025-06-01", "2025-06-30")!
    expect(r.start_date).toBe("2025-06-01")
    expect(r.clamped).toBe(false)
    expect(r.end.toISOString()).toBe("2025-07-01T00:00:00.000Z")
  })
  test("keeps the 31-day limit", () => {
    expect(err("vercel-ai-gateway", "2026-01-01", "2026-02-01")).toMatch(/maximum is 31/)
  })
})

describe("parseIsoDay", () => {
  test("strict", () => {
    expect(parseIsoDay("2026-07-23")).toBe(Date.UTC(2026, 6, 23))
    expect(parseIsoDay("2026-13-01")).toBeNull()
    expect(parseIsoDay(" 2026-07-23")).toBeNull()
  })
})
