/**
 * Issue #90: the headline split into fixed / subscription and variable /
 * usage, and Cursor usage grouped apart from Cursor seats.
 */

import { costNature, splitFixedVariable } from "./cost-types"
import { CURSOR_SEAT_SLICE_LABEL, cursorProductBucket, cursorProductGroups, splitCursorByProduct } from "./cursor-products"
import { computeDashboard } from "./dashboard-compute"
import { applyFilters } from "./dashboard-filters"
import { usageWindowLabel } from "./dashboard-types"
import { FORECAST_DEFAULTS } from "./forecast-settings"
import { PROV, RATES, novRows, row } from "./issue88-fixtures"
import { buildOrgIndex } from "./org/attribution"
import { PROVIDERS, RECORDS } from "./org/dashboard-fixtures"
import { toAttributedDailyRows, type CostRecordLike } from "./org/rollup"
import { D, orgData, P, PE, T } from "./org/test-fixtures"

const NOW = new Date("2026-11-06T15:00:00Z")
const cents = (n: number) => Math.round(n * 100)

describe("costNature (derived from licenseKind, not a provider list)", () => {
  it.each([
    ["cursor seats", "cursor"],
    ["seats", "claude-max"],
    ["anything", "chatgpt"],
    ["recurring", "lovable"],
    ["recurring seats", "anything"],
    ["manual", "lovable"],
    ["invoice adjustment", "anthropic"],
  ])("%s on %s is fixed", (model, slug) => expect(costNature(model, slug)).toBe("fixed"))

  it.each([
    ["grok-bot-default", "cursor"],
    ["github_bugbot", "cursor"],
    ["claude-opus-5-5", "anthropic"],
    ["claude_code", "claude-ai"],
    ["gpt-5", "openai"],
    ["anthropic/claude-sonnet", "vercel-ai-gateway"],
  ])("%s on %s is variable", (model, slug) => expect(costNature(model, slug)).toBe("variable"))
})

describe("splitFixedVariable", () => {
  it("rounds both sides so they add up to the headline's rounding to the cent", () => {
    for (const [total, fixed] of [
      [28988.934, 14500],
      [0.015, 0.005],
      [100.005, 33.3333],
      [10, 10],
      [0, 0],
      [-5.555, 1.111],
    ]) {
      const s = splitFixedVariable(total, fixed)
      expect(s.total).toBe(Math.round(total * 100) / 100)
      expect(cents(s.fixed) + cents(s.variable)).toBe(cents(s.total))
    }
  })
})

describe("headline KPIs: fixed + variable = Total Monthly Spend", () => {
  const dash = (daily = novRows()) =>
    computeDashboard({ daily, providers: PROV, params: { month: "2026-11" }, forecastSettings: FORECAST_DEFAULTS, now: NOW, cursorSeatRates: RATES })

  it("fixed is seats and licenses, variable is metered usage, summing to the total", () => {
    const { kpis } = dash()
    // novRows: Claude Ultra seats 7600 + Cursor seats 240 | grok-bot 100 + Anthropic 500 (Nov).
    expect(kpis.totalSpend).toBe(8440)
    expect(kpis.fixedSpend).toBe(7840)
    expect(kpis.variableSpend).toBe(600)
    expect(cents(kpis.fixedSpend) + cents(kpis.variableSpend)).toBe(cents(kpis.totalSpend))
  })

  it("fixed equals the Seats and licenses chart total (same rule as #88)", () => {
    const d = dash()
    expect(d.kpis.fixedSpend).toBe(d.byLicense.reduce((s, l) => s + l.total, 0))
  })

  it("sums to the cent with fractional amounts", () => {
    const { kpis } = dash([
      row("2026-11-01", "pv-cursor", "cursor seats", 40.005),
      row("2026-11-02", "pv-cursor", "grok-bot-default", 0.333),
      row("2026-11-02", "pv-cursor", "default", 0.333),
      row("2026-11-03", "pv-anthropic", "claude-opus-5-5", 12.3449),
    ])
    expect(cents(kpis.fixedSpend) + cents(kpis.variableSpend)).toBe(cents(kpis.totalSpend))
  })

  it("Cursor variable usage is the calendar month only, never usage back to the billing-cycle start", () => {
    const { kpis } = dash([
      // Cycle started Oct 19: these October usage events must not count in November.
      row("2026-10-20", "pv-cursor", "grok-bot-default", 900),
      row("2026-10-31", "pv-cursor", "github_bugbot", 90),
      ...[40, 60].map((c) => row("2026-11-01", "pv-cursor", "cursor seats", c)),
      row("2026-11-05", "pv-cursor", "grok-bot-default", 10),
    ])
    expect(kpis.variableSpend).toBe(10)
    // Seats are the full cycle subscription billed in November, not prorated.
    expect(kpis.fixedSpend).toBe(100)
    expect(kpis.totalSpend).toBe(110)
  })
})

describe("fixed + variable under person / team / department filters", () => {
  const seat = (person_email: string, cost: number): CostRecordLike => ({
    provider_id: P.cursor,
    timestamp: "2026-11-01T00:00:00Z",
    model_name: "cursor seats",
    cost_usd: cost,
    tokens_used: 0,
    request_count: 0,
    metadata: { attribution: { person_email, granularity: "person" } },
  })
  const org = orgData()
  const rows = () => toAttributedDailyRows([...RECORDS, seat("dave.alias@liatrio.com", 40), seat("alice@liatrio.com", 60)], buildOrgIndex(org))
  const base = { providers: PROVIDERS, params: { month: "2026-11" }, forecastSettings: FORECAST_DEFAULTS, now: NOW, projectForecast: false }

  it.each([
    [{}, 100],
    [{ person: PE.dave }, 40],
    [{ person: PE.alice }, 60],
    [{ team: T.data }, 40],
    [{ team: T.platform }, 60],
    [{ department: D.eng }, 100],
  ])("filter %o: fixed is that scope's seats and fixed + variable is its total", (filters, seats) => {
    const { kpis } = computeDashboard({ ...base, daily: applyFilters(rows(), filters) })
    expect(kpis.fixedSpend).toBe(seats)
    expect(cents(kpis.fixedSpend!) + cents(kpis.variableSpend!)).toBe(cents(kpis.totalSpend))
  })
})

describe("Cursor by product groups usage apart from seats", () => {
  const split = splitCursorByProduct([
    { model_name: "grok-bot-default", total_cost_usd: 4739.07 },
    { model_name: "github_bugbot", total_cost_usd: 1148.12 },
    { model_name: "grok-4.7-high", total_cost_usd: 1000 },
    { model_name: "cursor-grok-fast", total_cost_usd: 438.8 },
    { model_name: "cursor seats", total_cost_usd: 5600 },
  ])

  it("usage slice shares are of the usage subtotal, not of usage + seats", () => {
    const groups = cursorProductGroups(split.products)!
    expect(groups.map((g) => g.key)).toEqual(["variable", "fixed"])
    const [usage, fixed] = groups
    expect(usage.products.map((p) => p.product)).toEqual(["grok_bot", "bugbot", "agent_chat"])
    expect(usage.subtotal).toBe(7325.99)
    expect(fixed.subtotal).toBe(5600)
    expect(cents(usage.subtotal) + cents(fixed.subtotal)).toBe(cents(split.total))
    const grok = usage.products.find((p) => p.product === "grok_bot")!
    // ~64.7% of usage, not ~36.7% of the combined Cursor total.
    expect(grok.cost / usage.subtotal).toBeCloseTo(0.6469, 3)
    expect(grok.cost / split.total).not.toBeCloseTo(grok.cost / usage.subtotal, 2)
  })

  it("labels seats as subscription / fixed on the cycle, and usage as the calendar window", () => {
    const [usage, fixed] = cursorProductGroups(split.products, "Nov 1 – Nov 6, 2026 (month to date)")!
    expect(fixed.label).toMatch(/Subscription \(fixed\)/)
    expect(fixed.label).toMatch(/20th-to-20th/)
    expect(fixed.products).toEqual([{ product: "seats", label: CURSOR_SEAT_SLICE_LABEL, cost: 5600 }])
    expect(usage.label).toMatch(/Variable usage, calendar Nov 1 – Nov 6, 2026 \(month to date\)/)
  })

  it("no grouping when there are no seats", () => {
    expect(cursorProductGroups(splitCursorByProduct([{ model_name: "grok-bot-default", total_cost_usd: 1 }]).products)).toBeNull()
  })

  it("keeps the model buckets: grok-4.7-* and cursor-grok-* stay Agent/Chat", () => {
    expect(cursorProductBucket("grok-bot-automation")).toBe("grok_bot")
    expect(cursorProductBucket("github_bugbot")).toBe("bugbot")
    expect(cursorProductBucket("grok-4.7-high")).toBe("agent_chat")
    expect(cursorProductBucket("cursor-grok-fast")).toBe("agent_chat")
    expect(split.products.find((p) => p.product === "agent_chat")!.cost).toBe(1438.8)
  })
})

describe("usageWindowLabel", () => {
  it("is month to date for the current month", () => {
    expect(usageWindowLabel({ start: "2026-11-01", end: "2026-11-30" }, "2026-11-06")).toBe("Nov 1 – Nov 6, 2026 (month to date)")
  })
  it("is the whole month for a past month", () => {
    expect(usageWindowLabel({ start: "2026-10-01", end: "2026-10-31" }, "2026-11-06")).toBe("October 2026")
  })
})
