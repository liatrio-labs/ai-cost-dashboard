import "@testing-library/jest-dom"
import { render, screen, within } from "@testing-library/react"
import { ClaudeAiProductSplit } from "./claude-ai-products"
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
    const rows = screen.getAllByTestId("claude-ai-product-row")
    expect(rows.map((r) => r.textContent)).toEqual(["Claude Code$170.00", "Chat$70.25", "Other$4.75"])
  })

  it("renders no sub-rows without products", () => {
    render(<ToolsTable tools={[tool()]} />)
    expect(screen.queryAllByTestId("claude-ai-product-row")).toHaveLength(0)
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
