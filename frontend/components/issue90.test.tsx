/**
 * Issue #90: fixed / subscription vs variable / usage on the headline KPI and
 * on the Cursor by-product card (Dashboard and person view).
 */
import "@testing-library/jest-dom"
import { render, screen, within } from "@testing-library/react"
import { KPICards } from "@/components/kpi-cards"
import { CursorProductSplit, ToolProductCards } from "@/components/claude-ai-products"
import { OrgBreakdown } from "@/components/org/org-breakdown"
import { ToolsTable } from "@/components/tools-table"
import { computeDashboard } from "@/lib/dashboard-compute"
import { FORECAST_DEFAULTS } from "@/lib/forecast-settings"
import { PROV, RATES, novRows } from "@/lib/issue88-fixtures"
import { computeBreakdown } from "@/lib/org/breakdown"
import { buildOrgIndex } from "@/lib/org/attribution"
import { PROVIDERS, RECORDS } from "@/lib/org/dashboard-fixtures"
import { toAttributedDailyRows, type CostRecordLike } from "@/lib/org/rollup"
import { P, PE, orgData } from "@/lib/org/test-fixtures"
import type { DashboardTool } from "@/lib/dashboard-types"

const NOW = new Date("2026-11-06T15:00:00Z")
const dash = () =>
  computeDashboard({ daily: novRows(), providers: PROV, params: { month: "2026-11" }, forecastSettings: FORECAST_DEFAULTS, now: NOW, cursorSeatRates: RATES })
const money = (s: string | null) => Math.round(Number((s ?? "").replace(/[^0-9.-]/g, "")) * 100)

const PRODUCTS = [
  { product: "grok_bot" as const, label: "Grok Bot", cost: 4739.07 },
  { product: "bugbot" as const, label: "Bugbot", cost: 1148.12 },
  { product: "agent_chat" as const, label: "Agent/Chat", cost: 1438.8 },
  { product: "seats" as const, label: "Cursor seats", cost: 5600 },
]
const TOTAL = 12925.99

describe("headline KPI: Total plus Fixed / subscription and Variable / usage", () => {
  it("keeps Total Monthly Spend and shows fixed + variable summing to it", () => {
    const d = dash()
    render(<KPICards kpis={d.kpis} projection={d.projection as never} />)
    expect(screen.getByText("Total Monthly Spend")).toBeInTheDocument()
    expect(screen.getByText("$8,440.00")).toBeInTheDocument()
    const fixed = screen.getByTestId("spend-fixed")
    const variable = screen.getByTestId("spend-variable")
    expect(fixed).toHaveTextContent("Fixed / subscription")
    expect(fixed).toHaveTextContent("$7,840.00")
    expect(variable).toHaveTextContent("Variable / usage")
    expect(variable).toHaveTextContent("$600.00")
    expect(fixed).toHaveAttribute("title", expect.stringMatching(/seats, licenses/))
    expect(variable).toHaveAttribute("title", expect.stringMatching(/metered/))
    expect(money(fixed.querySelector("dd")!.textContent) + money(variable.querySelector("dd")!.textContent)).toBe(844000)
  })

  it("the early-month projection mark stays on the Total card's change line, not on the split", () => {
    const d = dash()
    render(<KPICards kpis={d.kpis} projection={d.projection as never} />)
    expect(within(screen.getByTestId("spend-split")).queryByTestId("low-confidence")).not.toBeInTheDocument()
  })

  it("renders no split for a payload without one", () => {
    render(<KPICards kpis={{ totalSpend: 10, prevSpend: 0, changePercent: 0, totalTokens: 0, activeProviders: 1, topProvider: "X" }} />)
    expect(screen.queryByTestId("spend-split")).not.toBeInTheDocument()
  })
})

describe("Cursor by product: usage grouped apart from seats", () => {
  it("seats are labeled subscription / fixed and sit in their own group, apart from Grok Bot / Bugbot / Agent/Chat", () => {
    render(<CursorProductSplit products={PRODUCTS} total={TOTAL} usageWindow="Nov 1 – Nov 6, 2026 (month to date)" />)
    const card = screen.getByTestId("cursor-products")
    const groups = within(card).getAllByTestId("product-group")
    expect(groups.map((g) => g.getAttribute("data-group"))).toEqual(["variable", "fixed"])
    const [usage, fixed] = groups
    const slices = (g: HTMLElement) => within(g).getAllByTestId("product-slice").map((s) => s.getAttribute("data-product"))
    expect(slices(usage)).toEqual(["grok_bot", "bugbot", "agent_chat"])
    expect(slices(fixed)).toEqual(["seats"])
    expect(fixed).toHaveTextContent(/Subscription \(fixed\)/)
    expect(fixed).toHaveTextContent("Cursor seats (subscription)")
    expect(fixed).toHaveTextContent(/20th-to-20th Cursor cycle, not prorated/)
    expect(usage).toHaveTextContent(/Variable usage, calendar Nov 1 – Nov 6, 2026 \(month to date\)/)
    expect(within(usage).getByTestId("product-group-subtotal")).toHaveTextContent("$7,325.99")
    expect(within(fixed).getByTestId("product-group-subtotal")).toHaveTextContent("$5,600.00")
  })

  it("usage slices take their share of the usage subtotal, not of usage + seats", () => {
    render(<CursorProductSplit products={PRODUCTS} total={TOTAL} />)
    const [usage] = screen.getAllByTestId("product-group")
    const share = (p: string) => within(usage).getAllByTestId("product-slice").find((s) => s.getAttribute("data-product") === p)!.getAttribute("data-share")
    expect(share("grok_bot")).toBe("64.7%")
    expect(share("bugbot")).toBe("15.7%")
    expect(share("agent_chat")).toBe("19.6%")
    expect(screen.getByTestId("cursor-products")).not.toHaveTextContent("36.7%")
  })

  it("seats never share a stacked bar with usage", () => {
    render(<CursorProductSplit products={PRODUCTS} total={TOTAL} />)
    const bars = screen.getAllByTestId("product-bar")
    expect(bars).toHaveLength(2)
    const segs = (b: HTMLElement) => Array.from(b.children).map((c) => c.getAttribute("data-product"))
    expect(segs(bars[0])).toEqual(["grok_bot", "bugbot", "agent_chat"])
    expect(segs(bars[1])).toEqual(["seats"])
  })

  it("still says it is not the billing-cycle on-demand figure and keeps the model-bucket copy", () => {
    render(<CursorProductSplit products={PRODUCTS} total={TOTAL} usageWindow="Nov 1 – Nov 6, 2026 (month to date)" />)
    const card = screen.getByTestId("cursor-products")
    expect(card).toHaveTextContent(/usage events dated Nov 1 – Nov 6, 2026 \(month to date\) only/)
    expect(card).toHaveTextContent(/Grok Bot is grok-bot-\* models, Bugbot is github_bugbot, Agent\/Chat is every other model/)
    expect(card).toHaveTextContent(/not the billing-cycle on-demand figure/)
    expect(card).toHaveTextContent(/usage percentages are of the usage subtotal/)
  })

  it("Dashboard tab card groups the same way", () => {
    const tool: DashboardTool = {
      id: "prov-cursor",
      name: "Cursor (Admin API)",
      monthlySpend: TOTAL,
      usageVolume: "—",
      change: "stable",
      changePercent: 0,
      changeDirection: "stable",
      subscriptionType: "Usage (API)",
      color: "#000",
      description: "",
      adminUrl: "",
      lastUpdated: null,
      products: PRODUCTS,
    }
    render(<ToolProductCards tools={[tool]} usageWindow="Nov 1 – Nov 6, 2026 (month to date)" />)
    const card = screen.getByTestId("cursor-products")
    expect(within(card).getByText("Cursor (Admin API) by product")).toBeInTheDocument()
    expect(within(card).getAllByTestId("product-group")).toHaveLength(2)
  })

  it("person view card groups the same way", () => {
    const seat: CostRecordLike = {
      provider_id: P.cursor,
      timestamp: "2026-11-01T00:00:00Z",
      model_name: "cursor seats",
      cost_usd: 40,
      tokens_used: 0,
      request_count: 0,
      metadata: { attribution: { person_email: "dave.alias@liatrio.com", granularity: "person" } },
    }
    const org = orgData()
    const data = computeBreakdown({
      rows: toAttributedDailyRows([...RECORDS, seat], buildOrgIndex(org)),
      org,
      providers: PROVIDERS,
      filters: { person: PE.dave },
      params: { month: "2026-11" },
      now: NOW,
    })
    render(<OrgBreakdown data={data} onFiltersChange={() => {}} />)
    const card = screen.getByTestId("cursor-products")
    const [usage, fixed] = within(card).getAllByTestId("product-group")
    expect(usage).toHaveTextContent(/Variable usage, calendar Nov 1 – Nov 6, 2026 \(month to date\)/)
    expect(within(usage).getByTestId("product-group-subtotal")).toHaveTextContent("$30.00")
    expect(within(fixed).getByTestId("product-group-subtotal")).toHaveTextContent("$40.00")
    expect(fixed).toHaveTextContent("Cursor seats (subscription)")
  })
})

describe("#89 Tools labeling is unchanged", () => {
  it("the Cursor row still shows seats and calendar on-demand as separate cost types", () => {
    const d = dash()
    render(<ToolsTable tools={d.tools} projection={d.projection as never} />)
    const note = screen.getByTestId("cursor-cost-types")
    expect(note).toHaveTextContent("Seats $240.00")
    expect(note).toHaveTextContent("Calendar on-demand $100.00")
  })
})
