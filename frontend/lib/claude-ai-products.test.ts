/**
 * Issue #48: Claude.ai spend by product. Product sums must equal the Claude.ai
 * total, and rows without a product label fall in Other.
 */

import {
  productBucket,
  splitClaudeAiByProduct,
  toProductDayRows,
  type ClaudeAiProductSplit,
  type ProductDayRow,
} from "./claude-ai-products"
import { computeDashboard } from "./dashboard-compute"
import { FORECAST_DEFAULTS } from "./forecast-settings"
import { applyFilters } from "./dashboard-filters"
import { buildOrgIndex } from "./org/attribution"
import { computeBreakdown } from "./org/breakdown"
import { orgData, PE } from "./org/test-fixtures"
import { attributedRows, plainDailyRows } from "./org/dashboard-fixtures"
import {
  CLAUDE_AI,
  NOV_ALICE,
  NOV_BOB,
  NOV_CLAUDE_AI,
  PROVIDERS_WITH_CLAUDE_AI,
  claudeAiAttributedRows,
  claudeAiPlainDailyRows,
  claudeAiProductCostRows,
} from "./claude-ai-product-fixtures"

const NOW = new Date("2026-11-03T12:00:00Z")
const cents = (n: number) => Math.round(n * 100)
const sumCents = (s: ClaudeAiProductSplit | { products: { cost: number }[] }) => s.products.reduce((a, p) => a + cents(p.cost), 0)
const byProduct = (s: { products: { product: string; cost: number }[] }) => Object.fromEntries(s.products.map((p) => [p.product, p.cost]))

describe("productBucket", () => {
  it("maps Claude Code and chat labels, everything else to Other", () => {
    expect(productBucket("claude_code")).toBe("claude_code")
    expect(productBucket("Claude-Code")).toBe("claude_code")
    expect(productBucket("claude_chat")).toBe("chat")
    expect(productBucket("chat")).toBe("chat")
    expect(productBucket("api")).toBe("other")
    expect(productBucket("something_new")).toBe("other")
  })

  it("puts rows without a product label in Other", () => {
    for (const v of [null, undefined, "", "   ", 42, {}]) expect(productBucket(v)).toBe("other")
  })
})

describe("splitClaudeAiByProduct", () => {
  const novRows = () => toProductDayRows(claudeAiProductCostRows()).filter((r) => r.date.startsWith("2026-11"))
  const novDaily = () => claudeAiPlainDailyRows().filter((r) => r.date.startsWith("2026-11"))

  it("matches the fixture baseline and sums to the Claude.ai total", () => {
    const s = splitClaudeAiByProduct(novDaily(), novRows())
    expect(s.total).toBe(NOV_CLAUDE_AI.total)
    expect(byProduct(s)).toEqual({ claude_code: NOV_CLAUDE_AI.claude_code, chat: NOV_CLAUDE_AI.chat, other: NOV_CLAUDE_AI.other })
    expect(sumCents(s)).toBe(cents(s.total))
    expect(s.products.map((p) => p.label)).toEqual(["Claude Code", "Chat", "Other"])
  })

  it("puts unlabelled spend (legacy fallback, null product) in Other", () => {
    const rows = toProductDayRows([
      { provider_id: CLAUDE_AI, timestamp: "2026-11-02T00:00:00Z", model_name: "m", cost_usd: 4, product: null },
      { provider_id: CLAUDE_AI, timestamp: "2026-11-02T00:00:00Z", model_name: "m", cost_usd: 6 },
    ])
    const s = splitClaudeAiByProduct([{ date: "2026-11-02", model_name: "m", total_cost_usd: 10 }], rows)
    expect(byProduct(s)).toEqual({ claude_code: 0, chat: 0, other: 10 })
  })

  it("keeps the total when the rollup and raw records disagree (stale rollup -> Other)", () => {
    // A rollup row with no raw records, and a rollup row larger than its raw records.
    const daily = [
      { date: "2026-11-01", model_name: "claude-opus-4-6", total_cost_usd: 300 }, // raw: code 170, chat 25 (195)
      { date: "2026-11-05", model_name: "claude-opus-4-6", total_cost_usd: 12.34 }, // no raw rows
    ]
    const s = splitClaudeAiByProduct(daily, novRows())
    expect(s.total).toBe(312.34)
    expect(sumCents(s)).toBe(cents(312.34))
    // 300 split 170:25 between Code and Chat; the unmatched 12.34 is Other.
    expect(byProduct(s)).toEqual({ claude_code: 261.54, chat: 38.46, other: 12.34 })
  })

  it("rounds to cents with no drift", () => {
    const rows: ProductDayRow[] = [
      { date: "d", model_name: "m", product: "claude_code", cost: 1 },
      { date: "d", model_name: "m", product: "chat", cost: 1 },
      { date: "d", model_name: "m", product: "other", cost: 1 },
    ]
    for (const total of [10, 0.01, 0.02, 100.005, 33.33, 1234567.89]) {
      const s = splitClaudeAiByProduct([{ date: "d", model_name: "m", total_cost_usd: total }], rows)
      expect(sumCents(s)).toBe(cents(s.total))
      for (const p of s.products) expect(Math.abs(p.cost - s.total / 3)).toBeLessThanOrEqual(0.01)
    }
  })

  it("handles an empty period", () => {
    const s = splitClaudeAiByProduct([], [])
    expect(s.total).toBe(0)
    expect(byProduct(s)).toEqual({ claude_code: 0, chat: 0, other: 0 })
  })
})

describe("computeDashboard with Claude.ai products", () => {
  const daily = () => [...plainDailyRows(), ...claudeAiPlainDailyRows()]
  const base = { providers: PROVIDERS_WITH_CLAUDE_AI, params: { month: "2026-11" }, forecastSettings: FORECAST_DEFAULTS, now: NOW }

  it("adds products to the Claude.ai tool, summing to its spend, with totals unchanged", () => {
    const without = computeDashboard({ ...base, daily: daily() })
    const withProducts = computeDashboard({ ...base, daily: daily(), claudeAiProductRows: toProductDayRows(claudeAiProductCostRows()) })

    const tool = withProducts.tools.find((t) => t.id === CLAUDE_AI)!
    expect(tool.monthlySpend).toBe(NOV_CLAUDE_AI.total)
    expect(sumCents(tool as { products: { cost: number }[] })).toBe(cents(tool.monthlySpend))
    expect(byProduct(tool as { products: { product: string; cost: number }[] })).toEqual({
      claude_code: NOV_CLAUDE_AI.claude_code,
      chat: NOV_CLAUDE_AI.chat,
      other: NOV_CLAUDE_AI.other,
    })
    // Only Claude.ai gets products; every other figure is unchanged.
    expect(withProducts.tools.filter((t) => "products" in t).map((t) => t.id)).toEqual([CLAUDE_AI])
    const strip = (d: typeof without) => ({ ...d, tools: d.tools.map(({ ...t }) => (delete (t as { products?: unknown }).products, t)) })
    expect(strip(withProducts)).toEqual(without)
  })

  it("adds no products when none were read, or the period has no Claude.ai spend", () => {
    expect(computeDashboard({ ...base, daily: daily() }).tools.some((t) => "products" in t)).toBe(false)
    const dec = computeDashboard({ ...base, params: { month: "2026-12" }, daily: daily(), claudeAiProductRows: [] })
    expect(dec.tools.some((t) => "products" in t)).toBe(false)
  })

  it("splits a person filter's Claude.ai spend (person view on the dashboard)", () => {
    const org = orgData()
    const index = buildOrgIndex(org)
    const rows = applyFilters([...attributedRows(org), ...claudeAiAttributedRows(org)], { person: PE.alice })
    const productRows = toProductDayRows(claudeAiProductCostRows(), { filters: { person: PE.alice }, index })
    const d = computeDashboard({ ...base, daily: rows, projectForecast: false, claudeAiProductRows: productRows })
    const tool = d.tools.find((t) => t.id === CLAUDE_AI)!
    expect(tool.monthlySpend).toBe(NOV_ALICE.total)
    expect(byProduct(tool as { products: { product: string; cost: number }[] })).toEqual({
      claude_code: NOV_ALICE.claude_code,
      chat: NOV_ALICE.chat,
      other: NOV_ALICE.other,
    })
  })
})

describe("computeBreakdown person view with Claude.ai products", () => {
  const org = orgData()
  const index = buildOrgIndex(org)
  const rows = () => [...attributedRows(org), ...claudeAiAttributedRows(org)]
  const breakdown = (filters: Record<string, string>, withProducts = true) =>
    computeBreakdown({
      rows: rows(),
      org,
      providers: PROVIDERS_WITH_CLAUDE_AI,
      filters,
      params: { month: "2026-11" },
      now: NOW,
      claudeAiProductRows: withProducts ? toProductDayRows(claudeAiProductCostRows(), { filters, index }) : null,
    })

  it.each([
    [PE.alice, NOV_ALICE],
    [PE.bob, NOV_BOB],
  ])("splits %s's Claude.ai spend, summing to their Claude.ai detail rows", (person, expected) => {
    const b = breakdown({ person })
    const detailTotal = b.detail.filter((d) => d.provider === "claude-ai").reduce((s, d) => s + cents(d.cost), 0)
    expect(b.claudeAiProducts!.total).toBe(expected.total)
    expect(cents(b.claudeAiProducts!.total)).toBe(detailTotal)
    expect(sumCents(b.claudeAiProducts!)).toBe(detailTotal)
    expect(byProduct(b.claudeAiProducts!)).toEqual({ claude_code: expected.claude_code, chat: expected.chat, other: expected.other })
  })

  it("leaves the rest of the breakdown unchanged", () => {
    const { claudeAiProducts: split, ...withP } = breakdown({ person: PE.alice })
    const { claudeAiProducts: none, ...without } = breakdown({ person: PE.alice }, false)
    expect(split).not.toBeNull()
    expect(none).toBeNull()
    expect(withP).toEqual(without)
  })

  it("is null for a person with no Claude.ai spend", () => {
    expect(breakdown({ person: PE.dave }).claudeAiProducts).toBeNull()
  })
})
