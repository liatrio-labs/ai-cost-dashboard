import { buildBreakdown, type BreakdownEntity } from "./breakdown"
import { applyFilters, parseFilters, toQueryString } from "./filters"
import { comparisonWindow, resolvePeriod } from "./period"
import { attributedRows, emptyOrg, providerRows, PROV } from "./test-fixtures"
import { D, K, orgData, PE, T } from "@/lib/org/test-fixtures"

const NOV = { month: "2026-11" }
const build = (filters = {}, org = orgData(), period: Record<string, string> = NOV) =>
  buildBreakdown(attributedRows(org), org, providerRows, period, filters)

const sum = (es: BreakdownEntity[]) => es.reduce((s, e) => s + e.spend, 0)
const byKey = (es: BreakdownEntity[]) => Object.fromEntries(es.map((e) => [e.key, e.spend]))
const find = (es: BreakdownEntity[], key: string) => es.find((e) => e.key === key)!

describe("buildBreakdown: reconciliation", () => {
  it("each level plus Unassigned sums to the org total", () => {
    const b = build()
    expect(b.total.spend).toBe(347)
    for (const level of [b.departments, b.teams, b.people, b.apiKeys]) {
      expect(sum(level)).toBeCloseTo(347, 6)
      expect(level[level.length - 1]).toMatchObject({ key: "unassigned", label: "Unassigned", unassigned: true })
    }
    expect(byKey(b.departments)).toEqual({ [D.eng]: 190, [D.sales]: 65, unassigned: 92 })
    expect(byKey(b.teams)).toEqual({ [T.platform]: 100, [T.data]: 90, [T.field]: 65, [T.orphan]: 8, unassigned: 84 })
    expect(byKey(b.people)).toEqual({ [PE.alice]: 160, [PE.bob]: 65, [PE.dave]: 30, [PE.carol]: 12, [PE.erin]: 8, unassigned: 72 })
    expect(byKey(b.apiKeys)).toEqual({ [K.team]: 60, [K.owner]: 25, [K.bare]: 5, unassigned: 257 })
  })

  it("per-provider splits sum to each entity's spend", () => {
    const b = build()
    for (const e of [...b.departments, ...b.teams, ...b.people, ...b.apiKeys]) {
      const s = Object.values(e.byProvider).reduce((a, c) => a + c, 0)
      expect(s).toBeCloseTo(e.spend, 6)
    }
    expect(find(b.people, PE.alice).byProvider).toEqual({ [PROV.anthropic]: 100, [PROV.openai]: 60 })
  })

  it("with no org structure, everything is Unassigned and totals match", () => {
    const b = build({}, emptyOrg())
    expect(b.orgConfigured).toBe(false)
    expect(b.total.spend).toBe(347)
    for (const level of [b.departments, b.teams, b.people, b.apiKeys]) {
      expect(level).toHaveLength(1)
      expect(level[0]).toMatchObject({ key: "unassigned", spend: 347, prevSpend: 150 })
    }
  })
})

describe("buildBreakdown: MoM per entity", () => {
  it("compares each entity to the previous calendar month", () => {
    const b = build()
    expect(b.comparison).toEqual({ start: "2026-10-01", end: "2026-10-31" })
    expect(b.total).toMatchObject({ spend: 347, prevSpend: 150, changePercent: 131 })
    expect(find(b.departments, D.eng)).toMatchObject({ spend: 190, prevSpend: 100, changePercent: 90 })
    expect(find(b.departments, D.sales)).toMatchObject({ prevSpend: 0, changePercent: null })
    expect(find(b.departments, "unassigned")).toMatchObject({ spend: 92, prevSpend: 50, changePercent: 84 })
    expect(find(b.people, PE.alice)).toMatchObject({ spend: 160, prevSpend: 80, changePercent: 100 })
    expect(find(b.teams, T.data)).toMatchObject({ spend: 90, prevSpend: 50, changePercent: 80 })
  })

  it("keeps entities that only had spend last month", () => {
    const b = build({}, orgData(), { start: "2026-10-14", end: "2026-10-31" })
    // Comparison window Sep 26 - Oct 13 holds all of October's spend.
    expect(find(b.people, PE.alice)).toMatchObject({ spend: 0, prevSpend: 80, changePercent: -100 })
  })
})

describe("buildBreakdown: filters", () => {
  it("team filter excludes other teams", () => {
    const b = build({ team: T.data })
    expect(b.total.spend).toBe(90)
    expect(byKey(b.teams)).toEqual({ [T.data]: 90, unassigned: 0 })
    expect(byKey(b.departments)).toEqual({ [D.eng]: 90, unassigned: 0 })
    expect(byKey(b.people)).toEqual({ [PE.alice]: 60, [PE.dave]: 30, unassigned: 0 })
    expect(byKey(b.apiKeys)).toEqual({ [K.team]: 60, unassigned: 30 })
  })

  it("person filter returns only that person, with provider x model detail", () => {
    const b = build({ person: PE.bob })
    expect(b.total.spend).toBe(65)
    expect(byKey(b.people)).toEqual({ [PE.bob]: 65, unassigned: 0 })
    expect(b.detail.map((d) => [d.providerName, d.model, d.spend])).toEqual([
      ["Anthropic API", "claude-sonnet", 40],
      ["OpenAI API", "gpt-5", 25],
    ])
  })

  it("department filter narrows teams to that department", () => {
    const b = build({ department: D.eng })
    expect(byKey(b.teams)).toEqual({ [T.platform]: 100, [T.data]: 90, unassigned: 0 })
  })

  it("filters combine, and 'unassigned' selects the Unassigned bucket", () => {
    expect(build({ department: D.eng, provider: PROV.cursor }).total.spend).toBe(30)
    expect(build({ department: "unassigned" }).total.spend).toBe(92)
    expect(byKey(build({ department: "unassigned" }).teams)).toEqual({ [T.orphan]: 8, unassigned: 84 })
    expect(build({ key: K.team }).total.spend).toBe(60)
  })

  it("API key rows carry provider, owner and team", () => {
    expect(find(build().apiKeys, K.team)).toMatchObject({
      label: "Data pipeline key",
      providerName: "OpenAI API",
      ownerLabel: "Alice",
      teamLabel: "Data",
    })
    expect(find(build().apiKeys, K.owner)).toMatchObject({ label: "key_owner", ownerLabel: "Bob", teamLabel: null })
  })
})

describe("coverage notes", () => {
  it("flags org-level-only providers on Unassigned rows", () => {
    const b = build()
    expect(find(b.departments, "unassigned").coverageNotes).toEqual(["Windsurf: org-level only (flat seat cost)"])
    expect(find(b.apiKeys, "unassigned").coverageNotes).toEqual([
      "Cursor: per member",
      "Windsurf: org-level only (flat seat cost)",
    ])
    const windsurf = b.providers.find((p) => p.slug === "windsurf")!
    expect(windsurf.canAttribute.person).toBe(false)
    expect(b.providers.find((p) => p.slug === "openai")!.canAttribute.person).toBe(true)
  })
})

describe("filters and periods", () => {
  it("parses only known, well-formed params and round-trips to a query string", () => {
    const f = parseFilters(new URLSearchParams("team=team-data&person=bad value&foo=1&provider=prov-openai"))
    expect(f).toEqual({ team: "team-data", provider: "prov-openai" })
    expect(toQueryString({ month: "2026-11" }, f)).toBe("?month=2026-11&team=team-data&provider=prov-openai")
    expect(toQueryString({}, {})).toBe("")
  })

  it("applyFilters is a no-op without filters", () => {
    const rows = attributedRows()
    expect(applyFilters(rows, {})).toBe(rows)
  })

  it("comparison window is the previous month, or the preceding range", () => {
    expect(comparisonWindow(resolvePeriod({ month: "2026-03" }))).toEqual({ start: "2026-02-01", end: "2026-02-28" })
    expect(comparisonWindow(resolvePeriod({ month: "2026-01" }))).toEqual({ start: "2025-12-01", end: "2025-12-31" })
    expect(comparisonWindow(resolvePeriod({ start: "2026-11-10", end: "2026-11-01" }))).toEqual({ start: "2026-10-22", end: "2026-10-31" })
  })
})
