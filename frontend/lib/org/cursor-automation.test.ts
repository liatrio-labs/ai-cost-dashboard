/**
 * Issue #51: Cursor spend with no user (Bugbot / team-level automation) is a
 * labelled line, "Cursor – Bugbot/automation", not Unassigned, and totals are
 * unchanged. Built through the real pipeline: Cursor collector transform ->
 * toAttributedDailyRows (the view's TS mirror) -> rollup / computeBreakdown.
 */

import { transform } from "@/lib/collectors/cursor"
import { applyFilters, matchesFilters, type DashboardFilters } from "@/lib/dashboard-filters"
import { narrowAttributed } from "@/lib/dashboard-data"
import { computeUnitForecasts, forecastUnitForFilters } from "@/lib/unit-forecast"
import { FORECAST_DEFAULTS } from "@/lib/forecast-settings"
import { computeBreakdown } from "./breakdown"
import { attributedRows, NOV_TOTAL, OCT_TOTAL, PROVIDERS, RECORDS } from "./dashboard-fixtures"
import { buildOrgIndex } from "./attribution"
import {
  AUTOMATION_KEY,
  AUTOMATION_LABEL,
  automationProviderIds,
  rollup,
  ROLLUP_LEVELS,
  toAttributedDailyRows,
  type CostRecordLike,
} from "./rollup"
import { P, orgData } from "./test-fixtures"

const NOW = new Date("2026-11-15T00:00:00Z")
const ms = (iso: string) => String(Date.parse(iso))

// Cursor usage events: two Bugbot / background events with no user ($12.34 +
// $7.66 in Nov, $5 in Oct) and one from an email that isn't a registered
// person ($3, stays Unassigned).
const EVENTS = [
  { timestamp: ms("2026-11-03T09:00:00Z"), model: "bugbot", kind: "Usage-based", chargedCents: 1234 },
  { timestamp: ms("2026-11-04T09:00:00Z"), model: "claude-4-sonnet", kind: "Background agent", chargedCents: 766 },
  { timestamp: ms("2026-10-20T09:00:00Z"), model: "bugbot", chargedCents: 500 },
  { timestamp: ms("2026-11-05T09:00:00Z"), userEmail: "stranger@liatrio.com", model: "gpt-5", chargedCents: 300 },
]
const AUTO_NOV = 20
const AUTO_OCT = 5
const STRANGER_NOV = 3

const cursorRecords = (): CostRecordLike[] =>
  transform(EVENTS, { userId: "u1", providerId: P.cursor }).map((r) => ({
    provider_id: r.provider_id,
    timestamp: r.timestamp,
    model_name: r.model_name,
    cost_usd: r.cost_usd,
    tokens_used: r.tokens_used,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    request_count: r.request_count,
    metadata: r.metadata as Record<string, unknown>,
  }))

const org = orgData()
const rows = () => toAttributedDailyRows([...RECORDS, ...cursorRecords()], buildOrgIndex(org))
const run = (filters: DashboardFilters = {}) =>
  computeBreakdown({ rows: rows(), org, providers: PROVIDERS, filters, params: { month: "2026-11" }, now: NOW })
const sum = (xs: { cost: number }[]) => Math.round(xs.reduce((s, x) => s + x.cost, 0) * 100) / 100
const AUTO_IDS = automationProviderIds(PROVIDERS)

describe("Cursor – Bugbot/automation line (issue #51)", () => {
  it("the collector writes no-user events as org-granularity rows with no person", () => {
    const recs = cursorRecords()
    const noUser = recs.filter((r) => (r.metadata as { member_email: string }).member_email === "unknown")
    expect(noUser).toHaveLength(3)
    for (const r of noUser) expect((r.metadata as { attribution: unknown }).attribution).toEqual({ granularity: "org" })
  })

  it.each(["department", "team", "person", "api_key"] as const)(
    "%s: no-user Cursor spend lands on the labelled line, not Unassigned, and totals are unchanged",
    (level) => {
      const d = run()
      expect(d.total.cost).toBe(NOV_TOTAL + AUTO_NOV + STRANGER_NOV)
      expect(d.total.prevCost).toBe(OCT_TOTAL + AUTO_OCT)
      expect(sum(d[level])).toBe(d.total.cost)

      const auto = d[level].find((e) => e.key === AUTOMATION_KEY)!
      expect(auto).toMatchObject({
        label: AUTOMATION_LABEL,
        unassigned: false,
        automation: true,
        id: null,
        cost: AUTO_NOV,
        prevCost: AUTO_OCT,
        changePercent: 300,
        byProvider: { cursor: AUTO_NOV },
      })
      expect(auto.coverage.map((c) => c.provider)).toEqual(["cursor"])
      // Just before Unassigned, which stays last and keeps no Cursor automation.
      expect(d[level].at(-2)?.key).toBe(AUTOMATION_KEY)
      const un = d[level].at(-1)!
      expect(un.unassigned).toBe(true)
      const baseline = computeBreakdown({ rows: attributedRows(org), org, providers: PROVIDERS, filters: {}, params: { month: "2026-11" }, now: NOW })
      const baseUn = baseline[level].at(-1)!
      // Only the unregistered Cursor user joins Unassigned.
      expect(un.cost).toBe(Math.round((baseUn.cost + STRANGER_NOV) * 100) / 100)
      expect(un.byProvider.cursor ?? 0).toBe(level === "api_key" ? (baseUn.byProvider.cursor ?? 0) + STRANGER_NOV : STRANGER_NOV)
    }
  )

  it("rollup without automation ids keeps the old behaviour (everything Unassigned)", () => {
    const r = rows()
    for (const level of ROLLUP_LEVELS) {
      const plain = rollup(r, level)
      const split = rollup(r, level, undefined, { automationProviderIds: AUTO_IDS })
      expect(plain.some((b) => b.key === AUTOMATION_KEY)).toBe(false)
      const plainUn = plain.at(-1)!.total_cost_usd
      const auto = split.find((b) => b.key === AUTOMATION_KEY)!.total_cost_usd
      expect(Math.round((auto + split.at(-1)!.total_cost_usd) * 1e6) / 1e6).toBe(plainUn)
      const total = (bs: { total_cost_usd: number }[]) => Math.round(bs.reduce((s, b) => s + b.total_cost_usd, 0) * 1e6) / 1e6
      expect(total(split)).toBe(total(plain))
    }
  })

  it("no automation line when there is no no-user Cursor spend", () => {
    const d = computeBreakdown({ rows: attributedRows(org), org, providers: PROVIDERS, filters: {}, params: { month: "2026-11" }, now: NOW })
    for (const level of ROLLUP_LEVELS) expect(d[level].some((e) => e.key === AUTOMATION_KEY)).toBe(false)
  })

  it("drills into the line: department -> team -> person -> detail", () => {
    const dept = run({ department: AUTOMATION_KEY })
    expect(dept.total.cost).toBe(AUTO_NOV)
    expect(dept.level).toBe("team")
    expect(dept.team.map((e) => [e.key, e.cost])).toEqual([[AUTOMATION_KEY, AUTO_NOV], ["unassigned", 0]])
    expect(dept.breadcrumbs).toEqual([{ key: "department", value: AUTOMATION_KEY, label: AUTOMATION_LABEL }])

    const person = run({ department: AUTOMATION_KEY, team: AUTOMATION_KEY, person: AUTOMATION_KEY })
    expect(person.level).toBe("detail")
    expect(person.detail.map((x) => [x.provider, x.model, x.cost])).toEqual([
      ["cursor", "bugbot", 12.34],
      ["cursor", "claude-4-sonnet", 7.66],
    ])
  })

  it("the unassigned filter excludes automation rows; the two partition the no-entity rows", () => {
    const un = run({ person: "unassigned" })
    const auto = run({ person: AUTOMATION_KEY })
    const base = computeBreakdown({ rows: attributedRows(org), org, providers: PROVIDERS, filters: { person: "unassigned" }, params: { month: "2026-11" }, now: NOW })
    expect(un.total.cost).toBe(base.total.cost + STRANGER_NOV)
    expect(auto.total.cost).toBe(AUTO_NOV)
  })

  it("filters: automation matches nothing without provider ids; never an id push-down", () => {
    const r = rows()
    expect(applyFilters(r, { person: AUTOMATION_KEY })).toEqual([])
    expect(applyFilters(r, { person: AUTOMATION_KEY }, null, AUTO_IDS).length).toBeGreaterThan(0)
    // A registered person's Cursor row is never automation.
    const dave = r.find((x) => x.provider_id === P.cursor && x.person_id)!
    expect(matchesFilters(dave, { person: AUTOMATION_KEY }, null, AUTO_IDS)).toBe(false)

    const calls: [string, string, unknown][] = []
    const q = {
      is(col: string, v: unknown) {
        calls.push(["is", col, v])
        return q
      },
      eq(col: string, v: unknown) {
        calls.push(["eq", col, v])
        return q
      },
    }
    narrowAttributed({ team: AUTOMATION_KEY }, null)(q as never)
    expect(calls).toEqual([["is", "team_id", null]])
    expect(forecastUnitForFilters({ team: AUTOMATION_KEY })).toBeNull()
    expect(forecastUnitForFilters({ department: AUTOMATION_KEY })).toBeNull()
  })

  it("unit forecasts: automation rows are their own unit, so Unassigned matches the unassigned filter (Bugbot review)", () => {
    const r = rows()
    for (const level of ["department", "team"] as const) {
      const res = computeUnitForecasts({ rows: r, level, settings: FORECAST_DEFAULTS, automationProviderIds: AUTO_IDS })
      const un = res.units.find((u) => u.key === "unassigned")!
      const auto = res.units.find((u) => u.key === AUTOMATION_KEY)!
      expect(auto.unassigned).toBe(false)
      const histTotal = (h: { total: number }[]) => Math.round(h.reduce((s, x) => s + x.total, 0) * 100) / 100
      // Unassigned history = exactly the rows the unassigned filter keeps.
      const field = level === "team" ? "team" : "department"
      const kept = applyFilters(r, { [field]: "unassigned" }, null, AUTO_IDS)
      expect(histTotal(un.history)).toBe(Math.round(kept.reduce((s, x) => s + Number(x.total_cost_usd), 0) * 100) / 100)
      expect(histTotal(auto.history)).toBe(AUTO_NOV + AUTO_OCT)
      // Without the ids, the old single Unassigned unit holds both.
      const old = computeUnitForecasts({ rows: r, level, settings: FORECAST_DEFAULTS })
      expect(old.units.some((u) => u.key === AUTOMATION_KEY)).toBe(false)
      expect(histTotal(old.units.find((u) => u.key === "unassigned")!.history)).toBe(
        Math.round((histTotal(un.history) + histTotal(auto.history)) * 100) / 100
      )
    }
  })
})
