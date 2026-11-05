/**
 * Issue #65: Cursor spend by product (Grok Bot, Bugbot, Agent/Chat), from the
 * model names Cursor rows carry. Slices sum to the Cursor total to the cent
 * and follow the person / team filters and the period.
 */

import { transform as cursorTransform } from "./collectors/cursor"
import { cursorProductBucket, splitCursorByProduct } from "./cursor-products"
import { computeDashboard } from "./dashboard-compute"
import { applyFilters } from "./dashboard-filters"
import { FORECAST_DEFAULTS } from "./forecast-settings"
import { buildOrgIndex } from "./org/attribution"
import { computeBreakdown } from "./org/breakdown"
import { PROVIDERS, RECORDS } from "./org/dashboard-fixtures"
import { toAttributedDailyRows, type CostRecordLike } from "./org/rollup"
import { orgData, P, PE, T } from "./org/test-fixtures"

const NOW = new Date("2026-11-03T12:00:00Z")
const cents = (n: number) => Math.round(n * 100)
const byProduct = (s: { products: { product: string; cost: number }[] }) => Object.fromEntries(s.products.map((p) => [p.product, p.cost]))
const sumCents = (s: { products: { cost: number }[] }) => s.products.reduce((a, p) => a + cents(p.cost), 0)

const rec = (timestamp: string, model_name: string, cost_usd: number, person_email: string): CostRecordLike => ({
  provider_id: P.cursor,
  timestamp,
  model_name,
  cost_usd,
  tokens_used: 100,
  input_tokens: 60,
  output_tokens: 40,
  request_count: 1,
  metadata: { attribution: { person_email, granularity: "person" } },
})

/**
 * On top of the base fixture (dave cursor-auto 30 on Nov 1 and Oct 5), Cursor rows with the real models:
 *   dave  (Data)     Nov 1 grok-bot-default 20.10, grok-bot-automation 10.70; Nov 2 github_bugbot 4.71, grok-4.7-high 3.33
 *   alice (Platform) Nov 1 default 7.77; Nov 2 github_bugbot 1.11
 *   zed   (not in org, Unassigned) Nov 2 default 2.00
 *   dave  Oct 7 grok-bot-default 9.00 (outside November)
 * Nov Cursor 79.72 = Grok Bot 30.80 + Bugbot 5.82 + Agent/Chat 43.10
 * Dave 68.84 = 30.80 + 4.71 + 33.33; Alice 8.88 = 0 + 1.11 + 7.77
 */
const CURSOR_RECORDS: CostRecordLike[] = [
  rec("2026-11-01T10:00:00Z", "grok-bot-default", 20.1, "dave.alias@liatrio.com"),
  rec("2026-11-01T10:00:00Z", "grok-bot-automation", 10.7, "dave.alias@liatrio.com"),
  rec("2026-11-02T10:00:00Z", "github_bugbot", 4.71, "dave.alias@liatrio.com"),
  rec("2026-11-02T10:00:00Z", "grok-4.7-high", 3.33, "dave.alias@liatrio.com"),
  rec("2026-11-01T10:00:00Z", "default", 7.77, "alice@liatrio.com"),
  rec("2026-11-02T10:00:00Z", "github_bugbot", 1.11, "alice@liatrio.com"),
  rec("2026-11-02T10:00:00Z", "default", 2, "zed@liatrio.com"),
  rec("2026-10-07T10:00:00Z", "grok-bot-default", 9, "dave.alias@liatrio.com"),
]
const NOV = { total: 79.72, grok_bot: 30.8, bugbot: 5.82, agent_chat: 43.1 }
const DAVE = { total: 68.84, grok_bot: 30.8, bugbot: 4.71, agent_chat: 33.33 }
const ALICE = { total: 8.88, grok_bot: 0, bugbot: 1.11, agent_chat: 7.77 }
const products = (s: typeof NOV) => ({ grok_bot: s.grok_bot, bugbot: s.bugbot, agent_chat: s.agent_chat })

const org = orgData()
const rows = () => toAttributedDailyRows([...RECORDS, ...CURSOR_RECORDS], buildOrgIndex(org))

describe("cursorProductBucket", () => {
  it.each(["grok-bot-default", "grok-bot-automation", "grok-bot-anything-new"])("%s is Grok Bot", (m) => {
    expect(cursorProductBucket(m)).toBe("grok_bot")
  })

  it("github_bugbot is Bugbot", () => expect(cursorProductBucket("github_bugbot")).toBe("bugbot"))

  it.each(["grok-4.7-high", "default", "cursor-auto", "claude-4.5-sonnet", "gpt-5", "grok-bot", "cursor"])("%s is Agent/Chat", (m) => {
    expect(cursorProductBucket(m)).toBe("agent_chat")
  })
})

describe("splitCursorByProduct", () => {
  it("splits by model and sums to the total", () => {
    const s = splitCursorByProduct([
      { model_name: "grok-bot-default", total_cost_usd: "20292" },
      { model_name: "grok-bot-automation", total_cost_usd: 10699 },
      { model_name: "github_bugbot", total_cost_usd: 4710 },
      { model_name: "grok-4.7-high", total_cost_usd: 1000 },
      { model_name: "default", total_cost_usd: 500 },
    ])
    expect(s.total).toBe(37201)
    expect(byProduct(s)).toEqual({ grok_bot: 30991, bugbot: 4710, agent_chat: 1500 })
    expect(s.products.map((p) => p.label)).toEqual(["Grok Bot", "Bugbot", "Agent/Chat"])
  })

  it("rounds to cents with no drift", () => {
    const third = 1 / 3
    const s = splitCursorByProduct([
      { model_name: "grok-bot-default", total_cost_usd: third },
      { model_name: "github_bugbot", total_cost_usd: third },
      { model_name: "default", total_cost_usd: third },
    ])
    expect(s.total).toBe(1)
    expect(sumCents(s)).toBe(100)
  })

  it("handles an empty period", () => {
    expect(byProduct(splitCursorByProduct([]))).toEqual({ grok_bot: 0, bugbot: 0, agent_chat: 0 })
  })
})

describe("computeDashboard Cursor products", () => {
  const base = { providers: PROVIDERS, params: { month: "2026-11" }, forecastSettings: FORECAST_DEFAULTS, now: NOW }
  const cursorTool = (d: ReturnType<typeof computeDashboard>) => d.tools.find((t) => t.id === P.cursor)!

  it("splits the period's Cursor spend, summing to the Cursor tool to the cent", () => {
    const t = cursorTool(computeDashboard({ ...base, daily: rows() }))
    expect(t.monthlySpend).toBe(NOV.total)
    expect(byProduct(t as { products: { product: string; cost: number }[] })).toEqual(products(NOV))
    expect(sumCents(t as { products: { cost: number }[] })).toBe(cents(t.monthlySpend))
  })

  it("honours the date range", () => {
    const t = cursorTool(computeDashboard({ ...base, params: { month: "2026-10" }, daily: rows() }))
    expect(t.monthlySpend).toBe(39)
    expect(byProduct(t as { products: { product: string; cost: number }[] })).toEqual({ grok_bot: 9, bugbot: 0, agent_chat: 30 })
  })

  it.each([
    [{ person: PE.dave }, DAVE],
    [{ person: PE.alice }, ALICE],
    [{ team: T.data }, DAVE],
    [{ team: T.platform }, ALICE],
  ])("honours filter %o", (filters, expected) => {
    const t = cursorTool(computeDashboard({ ...base, daily: applyFilters(rows(), filters), projectForecast: false }))
    expect(t.monthlySpend).toBe(expected.total)
    expect(byProduct(t as { products: { product: string; cost: number }[] })).toEqual(products(expected))
  })
})

describe("computeBreakdown Cursor products (person view)", () => {
  const breakdown = (filters: Record<string, string>, month = "2026-11") =>
    computeBreakdown({ rows: rows(), org, providers: PROVIDERS, filters, params: { month }, now: NOW })

  it.each([
    [PE.dave, DAVE],
    [PE.alice, ALICE],
  ])("splits %s's Cursor spend, summing to their Cursor detail rows", (person, expected) => {
    const b = breakdown({ person })
    expect(b.level).toBe("detail")
    const detail = b.detail.filter((d) => d.provider === "cursor").reduce((s, d) => s + cents(d.cost), 0)
    expect(cents(b.cursorProducts!.total)).toBe(detail)
    expect(sumCents(b.cursorProducts!)).toBe(detail)
    expect(b.cursorProducts!.total).toBe(expected.total)
    expect(byProduct(b.cursorProducts!)).toEqual(products(expected))
  })

  it("follows team filters and the period", () => {
    expect(byProduct(breakdown({ team: T.data }).cursorProducts!)).toEqual(products(DAVE))
    expect(byProduct(breakdown({ person: PE.dave }, "2026-10").cursorProducts!)).toEqual({ grok_bot: 9, bugbot: 0, agent_chat: 30 })
  })

  it("is null for a selection with no Cursor rows", () => {
    expect(breakdown({ person: PE.bob }).cursorProducts).toBeNull()
  })
})

/**
 * Issue #73: only on-demand (Usage-based) Cursor spend is billable. Events run
 * through the real collector transform, the rollup and computeDashboard.
 *   Included in Business: grok-bot-default 50.00, github_bugbot 20.00, default 30.00 (all $0 billable)
 *   Usage-based:          grok-bot-default 1.50, github_bugbot 2.25, default 4.00 (+ same day/person/model as an included event)
 * Billable Nov Cursor 7.75 = Grok Bot 1.50 + Bugbot 2.25 + Agent/Chat 4.00
 */
describe("Cursor on-demand only (issue #73)", () => {
  const ts = (d: number) => String(Date.UTC(2026, 10, d, 12))
  const ev = (d: number, model: string, kind: string, chargedCents: number, userEmail?: string) => ({
    timestamp: ts(d),
    model,
    kind,
    chargedCents,
    isChargeable: true,
    ...(userEmail ? { userEmail } : {}),
  })
  const INCLUDED = [
    ev(1, "grok-bot-default", "Included in Business", 5000, "dave.alias@liatrio.com"),
    ev(2, "github_bugbot", "Included in Business", 2000),
    ev(2, "default", "Included in Business", 3000, "alice@liatrio.com"),
  ]
  const USAGE_BASED = [
    ev(1, "grok-bot-default", "Usage-based", 150, "dave.alias@liatrio.com"),
    ev(2, "github_bugbot", "Usage-based", 225),
    ev(2, "default", "Usage-based", 400, "alice@liatrio.com"),
  ]
  const dash = (events: ReturnType<typeof ev>[]) => {
    const records = cursorTransform(events, { userId: "u", providerId: P.cursor })
    const daily = toAttributedDailyRows(records as CostRecordLike[], buildOrgIndex(org))
    return computeDashboard({ daily, providers: PROVIDERS, params: { month: "2026-11" }, forecastSettings: FORECAST_DEFAULTS, now: NOW, projectForecast: false })
  }
  const cursor = (d: ReturnType<typeof dash>) => d.tools.find((t) => t.id === P.cursor)

  it("Included-in-Business events do not add to monthlySpend or the spend KPI", () => {
    const d = dash(INCLUDED)
    expect(cursor(d)?.monthlySpend ?? 0).toBe(0)
    expect(d.kpis.totalSpend).toBe(0)
  })

  it("Usage-based events still add their charged amount to monthlySpend and the spend KPI", () => {
    const d = dash(USAGE_BASED)
    expect(cursor(d)!.monthlySpend).toBe(7.75)
    expect(d.kpis.totalSpend).toBe(7.75)
  })

  it("mixed Included + Usage-based: only the Usage-based part counts", () => {
    const d = dash([...INCLUDED, ...USAGE_BASED])
    expect(cursor(d)!.monthlySpend).toBe(7.75)
    expect(d.kpis.totalSpend).toBe(7.75)
  })

  it("product split (Grok Bot / Bugbot / Agent/Chat) still works on on-demand spend and sums to the tool total", () => {
    const t = cursor(dash([...INCLUDED, ...USAGE_BASED]))! as { monthlySpend: number; products: { product: string; label: string; cost: number }[] }
    expect(byProduct(t)).toEqual({ grok_bot: 1.5, bugbot: 2.25, agent_chat: 4 })
    expect(t.products.map((p) => p.label)).toEqual(["Grok Bot", "Bugbot", "Agent/Chat"])
    expect(sumCents(t)).toBe(cents(t.monthlySpend))
  })
})
