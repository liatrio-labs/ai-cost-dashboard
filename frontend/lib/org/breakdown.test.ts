import { computeBreakdown, comparisonPeriod, pctChange, type BreakdownData } from "./breakdown"
import { EMPTY_ORG, NOV_TOTAL, OCT_TOTAL, PROVIDERS, attributedRows } from "./dashboard-fixtures"
import { D, K, PE, T, orgData } from "./test-fixtures"
import type { DashboardFilters } from "@/lib/dashboard-filters"

const NOW = new Date("2026-11-15T00:00:00Z")
const run = (filters: DashboardFilters = {}, org = orgData()) =>
  computeBreakdown({ rows: attributedRows(org), org, providers: PROVIDERS, filters, params: { month: "2026-11" }, now: NOW })

const sum = (xs: { cost: number }[]) => Math.round(xs.reduce((s, x) => s + x.cost, 0) * 100) / 100
const row = (d: BreakdownData, level: "department" | "team" | "person" | "api_key", key: string) =>
  d[level].find((e) => e.key === key)

describe("computeBreakdown totals", () => {
  const d = run()

  it("reports the org total and previous month", () => {
    expect(d.total).toEqual({ cost: NOV_TOTAL, prevCost: OCT_TOTAL, changePercent: 138.1 })
    expect(d.comparePeriod).toEqual({ start: "2026-10-01", end: "2026-10-31" })
  })

  it.each(["department", "team", "person", "api_key"] as const)("%s rows plus Unassigned equal the org total", (level) => {
    expect(sum(d[level])).toBe(NOV_TOTAL)
    const un = d[level].filter((e) => e.unassigned)
    expect(un).toHaveLength(1)
    expect(d[level][d[level].length - 1].unassigned).toBe(true)
  })

  it("rolls up to the expected entities", () => {
    expect(d.department.map((e) => [e.label, e.cost])).toEqual([
      ["Engineering", 170],
      ["Sales", 50],
      ["Unassigned", 30],
    ])
    expect(d.team.map((e) => [e.label, e.cost])).toEqual([
      ["Platform", 100],
      ["Data", 70],
      ["Field", 50],
      ["Unassigned", 30],
    ])
    expect(row(d, "person", PE.alice)?.cost).toBe(140)
    expect(row(d, "api_key", K.team)).toMatchObject({ cost: 40, provider: "openai", owner: "Alice", team: "Data" })
    expect(row(d, "api_key", K.bare)).toMatchObject({ cost: 10, owner: null, team: null })
    expect(row(d, "api_key", "unassigned")?.cost).toBe(200)
  })

  it("computes MoM change per entity", () => {
    expect(row(d, "department", D.eng)).toMatchObject({ cost: 170, prevCost: 80, changePercent: 112.5 })
    expect(row(d, "department", D.sales)).toMatchObject({ prevCost: 0, changePercent: null })
    expect(row(d, "department", "unassigned")).toMatchObject({ cost: 30, prevCost: 25, changePercent: 20 })
    expect(row(d, "person", PE.dave)).toMatchObject({ cost: 30, prevCost: 30, changePercent: 0 })
    // Carol spent in October only: still listed, at -100%.
    expect(row(d, "person", PE.carol)).toMatchObject({ cost: 0, prevCost: 5, changePercent: -100 })
  })

  it("splits each entity by provider", () => {
    expect(row(d, "person", PE.alice)?.byProvider).toEqual({ anthropic: 100, openai: 40 })
    expect(row(d, "person", "unassigned")?.byProvider).toEqual({ openai: 10, windsurf: 20 })
  })

  it("adds coverage notes so gaps aren't read as $0", () => {
    const eng = row(d, "department", D.eng)!
    expect(eng.coverage.map((c) => c.provider)).toEqual(["windsurf"])
    expect(eng.coverage[0].note).toMatch(/org-level only/)
    // People: Windsurf can't attribute; OpenAI can (via key owner).
    expect(row(d, "person", PE.alice)!.coverage.map((c) => c.provider)).toEqual(["windsurf"])
    // Keys: Anthropic has keys; Cursor and Windsurf don't.
    expect(row(d, "api_key", K.team)!.coverage.map((c) => c.provider).sort()).toEqual(["cursor", "windsurf"])
    // Unassigned explains what landed there.
    expect(row(d, "person", "unassigned")!.coverage.map((c) => c.provider)).toEqual(["windsurf", "openai"])
    expect(d.providers.find((p) => p.slug === "windsurf")).toMatchObject({ person: "no", apiKey: false })
  })

  it("returns provider x model detail", () => {
    expect(d.detail[0]).toMatchObject({ provider: "anthropic", model: "claude-opus", cost: 110 })
    expect(sum(d.detail)).toBe(NOV_TOTAL)
  })
})

describe("computeBreakdown filters", () => {
  it("team filter excludes other teams", () => {
    const d = run({ team: T.data })
    expect(d.total.cost).toBe(70)
    expect(d.level).toBe("person")
    expect(d.team.filter((e) => e.cost > 0).map((e) => e.key)).toEqual([T.data])
    expect(d.person.filter((e) => e.cost > 0).map((e) => [e.key, e.cost])).toEqual([
      [PE.alice, 40],
      [PE.dave, 30],
    ])
    expect(d.api_key.filter((e) => e.cost > 0).map((e) => e.key)).toEqual([K.team, "unassigned"])
    expect(d.breadcrumbs).toEqual([{ key: "team", value: T.data, label: "Data" }])
  })

  it("person filter returns only that person", () => {
    const d = run({ person: PE.alice })
    expect(d.level).toBe("detail")
    expect(d.total.cost).toBe(140)
    expect(d.person.filter((e) => e.cost > 0 || e.prevCost > 0).map((e) => e.key)).toEqual([PE.alice])
    expect(d.detail.map((x) => [x.provider, x.model, x.cost])).toEqual([
      ["anthropic", "claude-opus", 60],
      ["anthropic", "claude-sonnet", 40],
      ["openai", "gpt-5", 40],
    ])
  })

  it("department filter drills to teams", () => {
    const d = run({ department: D.eng })
    expect(d.level).toBe("team")
    expect(d.total).toMatchObject({ cost: 170, prevCost: 80 })
    expect(d.team.filter((e) => e.cost > 0).map((e) => e.label)).toEqual(["Platform", "Data"])
  })

  it("combines filters (department + provider)", () => {
    const d = run({ department: D.eng, provider: "openai" })
    expect(d.total.cost).toBe(40)
    expect(d.providers.map((p) => p.slug)).toEqual(["openai"])
  })

  it("unassigned filter selects rows with no entity", () => {
    const d = run({ department: "unassigned" })
    expect(d.total.cost).toBe(30)
    expect(d.breadcrumbs[0].label).toBe("Unassigned")
  })

  it("key filter returns only that key", () => {
    const d = run({ key: K.team })
    expect(d.total.cost).toBe(40)
  })

  it("unknown provider matches nothing", () => {
    expect(run({ provider: "nope" }).total.cost).toBe(0)
  })
})

describe("computeBreakdown with no org structure", () => {
  const d = run({}, EMPTY_ORG)

  it("puts everything in Unassigned at every level", () => {
    expect(d.orgConfigured).toBe(false)
    for (const level of ["department", "team", "person", "api_key"] as const) {
      expect(d[level]).toHaveLength(1)
      expect(d[level][0]).toMatchObject({ unassigned: true, cost: NOV_TOTAL, prevCost: OCT_TOTAL })
    }
  })
})

describe("helpers", () => {
  it("pctChange is null without prior spend", () => {
    expect(pctChange(10, 0)).toBeNull()
    expect(pctChange(15, 10)).toBe(50)
  })

  it("comparisonPeriod uses the previous calendar month, across years", () => {
    expect(comparisonPeriod({ start: "2026-01-01", end: "2026-01-31", mode: "month" })).toEqual({ start: "2025-12-01", end: "2025-12-31" })
    expect(comparisonPeriod({ start: "2026-03-01", end: "2026-03-31", mode: "month" })).toEqual({ start: "2026-02-01", end: "2026-02-28" })
    expect(comparisonPeriod({ start: "2026-11-10", end: "2026-11-19", mode: "range" })).toEqual({ start: "2026-10-31", end: "2026-11-09" })
  })
})
