import "@testing-library/jest-dom"
import { render, screen, within } from "@testing-library/react"
import { ClaudeAiProductSplit, CursorProductSplit, ToolProductCards } from "./claude-ai-products"
import { ToolsTable } from "./tools-table"
import { OrgBreakdown } from "./org/org-breakdown"
import { computeBreakdown } from "@/lib/org/breakdown"
import { buildOrgIndex } from "@/lib/org/attribution"
import { attributedRows } from "@/lib/org/dashboard-fixtures"
import { PE, orgData } from "@/lib/org/test-fixtures"
import { toProductDayRows } from "@/lib/claude-ai-products"
import {
  PROVIDERS_WITH_CLAUDE_AI,
  claudeAiAttributedRows,
  claudeAiProductCostRows,
} from "@/lib/claude-ai-product-fixtures"
import type { DashboardTool } from "@/lib/dashboard-types"

const PRODUCTS = [
  { product: "claude_code" as const, label: "Claude Code", cost: 170 },
  { product: "chat" as const, label: "Chat", cost: 70.25 },
  { product: "other" as const, label: "Other", cost: 4.75 },
]

const tool = (over: Partial<DashboardTool> = {}): DashboardTool => ({
  id: "prov-claude-ai",
  name: "Claude.ai (Enterprise Analytics)",
  monthlySpend: 245,
  usageVolume: "—",
  change: "stable",
  changePercent: 0,
  changeDirection: "stable",
  subscriptionType: "Usage (API)",
  color: "#24AE1D",
  ...over,
})

describe("ClaudeAiProductSplit", () => {
  it("lists Claude Code, Chat and Other with amounts and shares", () => {
    render(<ClaudeAiProductSplit products={PRODUCTS} total={245} />)
    const card = screen.getByTestId("claude-ai-products")
    expect(within(card).getByText("Claude.ai by product")).toBeInTheDocument()
    expect(within(card).getByText("$170.00")).toBeInTheDocument()
    expect(within(card).getByText("$70.25")).toBeInTheDocument()
    expect(within(card).getByText("$4.75")).toBeInTheDocument()
    expect(within(card).getByText("69.4%")).toBeInTheDocument()
    expect(within(card).getByText(/adds up to the Claude.ai total of \$245.00/)).toBeInTheDocument()
  })
})

describe("ToolsTable Claude.ai sub-rows", () => {
  it("adds one sub-row per product under Claude.ai only", () => {
    render(<ToolsTable tools={[tool({ products: PRODUCTS }), tool({ id: "prov-openai", name: "OpenAI API", monthlySpend: 50 })]} />)
    const rows = screen.getAllByTestId("product-row")
    expect(rows.map((r) => r.textContent)).toEqual(["Claude Code$170.00", "Chat$70.25", "Other$4.75"])
  })

  it("renders no sub-rows without products", () => {
    render(<ToolsTable tools={[tool()]} />)
    expect(screen.queryAllByTestId("product-row")).toHaveLength(0)
  })
})

describe("person view", () => {
  it("shows the person's Claude.ai split on the detail level", () => {
    const org = orgData()
    const filters = { person: PE.alice }
    const data = computeBreakdown({
      rows: [...attributedRows(org), ...claudeAiAttributedRows(org)],
      org,
      providers: PROVIDERS_WITH_CLAUDE_AI,
      filters,
      params: { month: "2026-11" },
      now: new Date("2026-11-15T00:00:00Z"),
      claudeAiProductRows: toProductDayRows(claudeAiProductCostRows(), { filters, index: buildOrgIndex(org) }),
    })
    render(<OrgBreakdown data={data} onFiltersChange={() => {}} />)
    const card = screen.getByTestId("claude-ai-products")
    expect(within(card).getByText("$120.00")).toBeInTheDocument()
    expect(within(card).getByText("$40.00")).toBeInTheDocument()
    expect(within(card).getByText("$0.00")).toBeInTheDocument()
    expect(within(card).getByText(/\$160.00/)).toBeInTheDocument()
  })
})

// Issue #65 ---------------------------------------------------------------

const CURSOR_PRODUCTS = [
  { product: "grok_bot" as const, label: "Grok Bot", cost: 30.8 },
  { product: "bugbot" as const, label: "Bugbot", cost: 5.82 },
  { product: "agent_chat" as const, label: "Agent/Chat", cost: 43.1 },
]
const OTHER_LABELS = ["claude_design", "claude_tag", "voice_mode", "office_agent", "claude_in_chrome", "research", "code_review"]

describe("Other's raw labels", () => {
  const products = PRODUCTS.map((p) => (p.product === "other" ? { ...p, labels: OTHER_LABELS } : p))

  it("lists them under Other, with all of them in the tooltip", () => {
    render(<ClaudeAiProductSplit products={products} total={245} />)
    const card = screen.getByTestId("claude-ai-products")
    const list = within(card).getByTestId("product-labels")
    expect(list).toHaveTextContent("claude_design, claude_tag, voice_mode, office_agent, claude_in_chrome, research +1 more")
    expect(list.closest("li")).toHaveAttribute("title", `Other includes: ${OTHER_LABELS.join(", ")}`)
    expect(within(card).getAllByTestId("product-labels")).toHaveLength(1)
  })

  it("puts them in the Tools sub-row tooltip", () => {
    render(<ToolsTable tools={[tool({ products })]} />)
    const other = screen.getAllByTestId("product-row").find((r) => r.getAttribute("data-product") === "other")!
    expect(within(other).getByText("Other").closest("[title]")).toHaveAttribute("title", `Other includes: ${OTHER_LABELS.join(", ")}`)
  })
})

describe("CursorProductSplit", () => {
  it("lists Grok Bot, Bugbot and Agent/Chat with amounts and shares", () => {
    render(<CursorProductSplit products={CURSOR_PRODUCTS} total={79.72} />)
    const card = screen.getByTestId("cursor-products")
    expect(within(card).getByText("Cursor by product")).toBeInTheDocument()
    expect(within(card).getByText("Grok Bot")).toBeInTheDocument()
    expect(within(card).getByText("Bugbot")).toBeInTheDocument()
    expect(within(card).getByText("Agent/Chat")).toBeInTheDocument()
    expect(within(card).getByText("$30.80")).toBeInTheDocument()
    expect(within(card).getByText("$5.82")).toBeInTheDocument()
    expect(within(card).getByText("$43.10")).toBeInTheDocument()
    expect(within(card).getByText(/adds up to the Cursor total of \$79.72/)).toBeInTheDocument()
  })
})

describe("ToolProductCards (Dashboard tab)", () => {
  it("shows a card for Claude.ai and for Cursor, titled with the tool names", () => {
    render(
      <ToolProductCards
        tools={[
          tool({ products: PRODUCTS }),
          tool({ id: "prov-cursor", name: "Cursor (Admin API)", monthlySpend: 79.72, products: CURSOR_PRODUCTS }),
          tool({ id: "prov-openai", name: "OpenAI API", monthlySpend: 50 }),
        ]}
      />
    )
    expect(within(screen.getByTestId("claude-ai-products")).getByText("Claude.ai (Enterprise Analytics) by product")).toBeInTheDocument()
    const cursor = screen.getByTestId("cursor-products")
    expect(within(cursor).getByText("Cursor (Admin API) by product")).toBeInTheDocument()
    expect(within(cursor).getByText("$30.80")).toBeInTheDocument()
  })

  it("renders nothing without products", () => {
    const { container } = render(<ToolProductCards tools={[tool()]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("person view Cursor card", () => {
  it("shows the person's Cursor split on the detail level", () => {
    const org = orgData()
    const data = computeBreakdown({
      rows: attributedRows(org),
      org,
      providers: PROVIDERS_WITH_CLAUDE_AI,
      filters: { person: PE.dave },
      params: { month: "2026-11" },
      now: new Date("2026-11-15T00:00:00Z"),
    })
    render(<OrgBreakdown data={data} onFiltersChange={() => {}} />)
    const card = screen.getByTestId("cursor-products")
    // Base fixture: dave's November Cursor spend is 30 on cursor-auto (Agent/Chat).
    expect(within(card).getByText("$30.00")).toBeInTheDocument()
    expect(within(card).getAllByText("$0.00")).toHaveLength(2)
    expect(within(card).getByText(/Cursor total of \$30.00/)).toBeInTheDocument()
  })

  it("is not shown above the detail level", () => {
    const org = orgData()
    const data = computeBreakdown({
      rows: attributedRows(org),
      org,
      providers: PROVIDERS_WITH_CLAUDE_AI,
      filters: {},
      params: { month: "2026-11" },
      now: new Date("2026-11-15T00:00:00Z"),
    })
    render(<OrgBreakdown data={data} onFiltersChange={() => {}} />)
    expect(screen.queryByTestId("cursor-products")).toBeNull()
  })
})
