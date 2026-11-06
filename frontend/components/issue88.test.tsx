/**
 * Issue #88: Nov 6 live-review accuracy and usability fixes, in the UI.
 */
import "@testing-library/jest-dom"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ModelBreakdownChart, SeatsLicensesChart } from "@/components/model-breakdown-chart"
import { ToolsTable } from "@/components/tools-table"
import { SpendBreakdownChart } from "@/components/spend-breakdown-chart"
import { KPICards } from "@/components/kpi-cards"
import { CursorCycleSpendCard } from "@/components/cursor-cycle-spend"
import { DrilldownTable, OrgBreakdown, OrgFilterBar, disambiguate } from "@/components/org/org-breakdown"
import { computeDashboard, type ProviderRow } from "@/lib/dashboard-compute"
import { computeBreakdown, type BreakdownData } from "@/lib/org/breakdown"
import { PROVIDERS, attributedRows } from "@/lib/org/dashboard-fixtures"
import { D, PE, orgData } from "@/lib/org/test-fixtures"
import { FORECAST_DEFAULTS } from "@/lib/forecast-settings"
import type { DashboardProjection } from "@/lib/dashboard-types"
import type { CursorCycleView } from "@/lib/cursor-spend"
import { PROV, RATES, novRows } from "@/lib/issue88-fixtures"

jest.mock("@/lib/csv", () => ({ ...jest.requireActual("@/lib/csv"), downloadCsv: jest.fn() }))

const NOW = new Date("2026-11-06T15:00:00Z")
const dash = () =>
  computeDashboard({ daily: novRows(), providers: PROV, params: { month: "2026-11" }, forecastSettings: FORECAST_DEFAULTS, now: NOW, cursorSeatRates: RATES })

const CYCLE: CursorCycleView = {
  available: true,
  current: {
    cycleStart: "2026-10-19T00:00:00.000Z",
    cycleEnd: "2026-11-19T00:00:00.000Z",
    cycleEndEstimated: false,
    teamSpendCents: 732600,
    teamOverallSpendCents: null,
    memberCount: 1,
    capturedAt: "2026-11-06T12:00:00.000Z",
    firstCapturedAt: null,
    members: [
      {
        email: "a@liatrio.com",
        name: "A",
        role: null,
        spendCents: 732600,
        overallSpendCents: null,
        monthlyLimitDollars: null,
        hardLimitOverrideDollars: null,
        effectivePerUserLimitDollars: null,
      },
    ],
  },
  previous: [],
}

describe("Spend by Model vs Seats and licenses (#88 AC1)", () => {
  it("seats excluded from the model chart and shown as labeled licenses", () => {
    const d = dash()
    render(
      <>
        <ModelBreakdownChart byModel={d.byModel} />
        <SeatsLicensesChart licenses={d.byLicense} />
      </>
    )
    const lic = screen.getByTestId("seats-licenses")
    expect(within(lic).getByText("Seats and licenses")).toBeInTheDocument()
    const rows = within(lic).getAllByTestId("license-row").map((r) => r.textContent)
    expect(rows).toEqual(["Claude Ultra seats$7,600.00", "Cursor seats$240.00"])
    expect(d.byModel.map((m) => m.model)).not.toContain("seats")
    expect(d.byModel.map((m) => m.model)).not.toContain("cursor seats")
  })
})

describe("Cursor Tools row cost types (#88 AC2, AC4)", () => {
  const projection = dash().projection as DashboardProjection

  it("Cursor totals are not subtitled on-demand only when seats are included", () => {
    render(<ToolsTable tools={dash().tools} projection={projection} cursorCycle={CYCLE} />)
    expect(screen.queryByText("on-demand only")).not.toBeInTheDocument()
    expect(screen.queryByTestId("cursor-on-demand-note")).not.toBeInTheDocument()
  })

  it("distinct cost-type labeling: seats, calendar on-demand, and billing-cycle on-demand from saved cycle dates", () => {
    render(<ToolsTable tools={dash().tools} projection={projection} cursorCycle={CYCLE} />)
    expect(screen.getByTestId("cost-type-seats")).toHaveTextContent("Seats $240.00")
    expect(screen.getByTestId("cost-type-calendar")).toHaveTextContent("Calendar on-demand $100.00")
    const cycle = screen.getByTestId("cost-type-cycle")
    expect(cycle).toHaveTextContent("Billing-cycle on-demand (Oct 19, 2026 to Nov 19, 2026): $7,326.00, separate window, not included above")
    expect(screen.getByTestId("cursor-seat-composition")).toHaveTextContent("Seats: 3 Standard × $40.00 + 2 Premium × $60.00 = $240.00")
    const title = screen.getByTestId("cursor-cost-types").getAttribute("title")!
    expect(title).toMatch(/\$240\.00 seats \+ \$100\.00 calendar on-demand/)
    expect(title).toMatch(/not added to this total/)
  })

  it("uses whatever cycle dates are saved, not hardcoded ones", () => {
    const other: CursorCycleView = { ...CYCLE, current: { ...CYCLE.current!, cycleStart: "2026-11-19T00:00:00.000Z", cycleEnd: "2026-12-19T00:00:00.000Z" } }
    render(<ToolsTable tools={dash().tools} projection={projection} cursorCycle={other} />)
    expect(screen.getByTestId("cost-type-cycle")).toHaveTextContent("Nov 19, 2026 to Dec 19, 2026")
  })
})

describe("headline and donut rounding (#88 AC9)", () => {
  it("matching headline/donut rounding", () => {
    const tools = [
      { ...dash().tools[0], monthlySpend: 10.01 },
      { ...dash().tools[1], monthlySpend: 10.01 },
    ]
    render(<SpendBreakdownChart tools={tools} total={20.01} />)
    expect(screen.getByTestId("donut-total")).toHaveTextContent("$20.01")
  })
})

describe("projection low-confidence (#88 AC8)", () => {
  it("early-month KPI change is capped and marked low-confidence, actual stays", () => {
    const d = dash()
    const projection: DashboardProjection = {
      ...d.projection,
      basis: { completeDays: 5, completeThrough: "2026-11-05" },
      kpis: { projectedSpend: 30000, actualToDate: 8400, compareSpend: 9800, changePercent: 206.1 },
    }
    render(<KPICards kpis={d.kpis} projection={projection} />)
    expect(screen.getByText(">+100% projected")).toBeInTheDocument()
    const mark = screen.getByTestId("low-confidence")
    expect(mark.getAttribute("title")).toMatch(/only 5 complete days/)
    expect(screen.getByText("$8,440.00")).toBeInTheDocument() // actual headline unchanged
  })
})

describe("overall incl. included column (#88 AC3)", () => {
  it("is hidden with an explanation when no member has stored included usage", () => {
    render(<CursorCycleSpendCard view={CYCLE} />)
    expect(screen.queryByText("Overall incl. included")).not.toBeInTheDocument()
    expect(screen.getByTestId("cursor-cycle-overall-missing")).toHaveTextContent(/didn.t report it/)
  })
})

const ORG_NOW = new Date("2026-11-15T00:00:00Z")
const breakdown = (filters = {}, org = orgData()) =>
  computeBreakdown({ rows: attributedRows(org), org, providers: PROVIDERS, filters, params: { month: "2026-11" }, now: ORG_NOW })

describe("Org tab (#88 AC5, AC7, AC13)", () => {
  it("Org row drill-in: clicking anywhere on a department row drills into its teams", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<DrilldownTable data={breakdown()} onFiltersChange={onChange} />)
    expect(screen.getByText(/Select a row to drill into its teams\./)).toBeInTheDocument()
    expect(screen.getByText(/vs October 2026\./)).toBeInTheDocument() // readable compare period
    const row = screen.getAllByTestId("drill-row").find((r) => r.textContent?.startsWith("Engineering"))!
    await user.click(within(row).getAllByRole("cell")[1]) // the Spend cell, not the name button
    expect(onChange).toHaveBeenLastCalledWith({ department: D.eng })
  })

  it("Unassigned rows say which bucket they are, with a definition", () => {
    render(<OrgBreakdown data={breakdown()} onFiltersChange={() => {}} />)
    expect(screen.getByRole("button", { name: "Unassigned (no department)" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Unassigned (no matched person)" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Unassigned (no registered key)" })).toBeInTheDocument()
    expect(screen.getAllByTestId("unassigned-definition").length).toBeGreaterThanOrEqual(3)
  })

  it("Lovable include/exclude note matches totals: other rows say it is counted in Unassigned", () => {
    const providers: ProviderRow[] = [...PROVIDERS, { id: "pv-lovable", name: "lovable", display_name: "Lovable", metadata: {} }]
    const org = orgData()
    const rows = [
      ...attributedRows(org),
      { date: "2026-11-01", provider_id: "pv-lovable", model_name: "manual", total_cost_usd: 400, total_tokens: 0, total_requests: 0, record_count: 1, granularity: "org", person_id: null, team_id: null, department_id: null, org_api_key_id: null, project_id: null },
    ] as unknown as ReturnType<typeof attributedRows>
    const data = computeBreakdown({ rows, org, providers, filters: {}, params: { month: "2026-11" }, now: ORG_NOW })
    render(<DrilldownTable data={data} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "Departments" })
    const eng = within(table).getByRole("button", { name: "Engineering" }).closest("tr")!
    expect(within(eng).getByTestId("coverage")).toHaveTextContent(/^Counted in Unassigned, not this row: .*Lovable: org-level only/)
    expect(within(eng).getByTestId("coverage")).not.toHaveTextContent(/Not included/)
    const un = within(table).getByRole("button", { name: "Unassigned (no department)" }).closest("tr")!
    expect(within(un).getByTestId("coverage")).toHaveTextContent(/^Includes .*Lovable/)
    expect(within(un).getByText("$430.00")).toBeInTheDocument() // Windsurf 20 + key_bare 10 + Lovable 400
  })

  it("People table search narrows the rows", async () => {
    const user = userEvent.setup()
    render(<OrgBreakdown data={breakdown({ department: D.eng })} onFiltersChange={() => {}} />)
    const people = screen.getByRole("table", { name: "People" })
    const before = within(people).getAllByTestId("person-row").length
    await user.type(screen.getByLabelText("Search people"), "ali")
    const after = within(screen.getByRole("table", { name: "People" })).getAllByTestId("person-row")
    expect(after.length).toBeLessThan(before)
    expect(after.map((r) => r.textContent)).toEqual([expect.stringMatching(/^Alice/)])
  })
})

describe("filter bar (#88 AC11, AC12)", () => {
  it("searchable person dropdown narrows the Person options, keeping the selected one", async () => {
    const user = userEvent.setup()
    render(<OrgFilterBar data={breakdown()} filters={{ person: PE.dave }} onFiltersChange={() => {}} />)
    const options = () => within(screen.getByLabelText("Person")).getAllByRole("option").map((o) => o.textContent)
    expect(options()).toEqual(expect.arrayContaining(["Alice", "Dave"]))
    await user.type(screen.getByLabelText("Search Person list"), "ali")
    expect(options()).toContain("Alice")
    expect(options()).toContain("Dave") // the current selection stays listed
    expect(options()).not.toContain("Bob")
    expect(screen.getByLabelText("Search API key list")).toBeInTheDocument()
  })

  it("Clear filters is always present and only enabled with an active filter", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const { rerender } = render(<OrgFilterBar data={breakdown()} filters={{}} onFiltersChange={onChange} />)
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeDisabled()
    rerender(<OrgFilterBar data={breakdown()} filters={{ person: PE.alice }} onFiltersChange={onChange} />)
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(onChange).toHaveBeenLastCalledWith({})
  })

  it("duplicate labels are told apart, not merged", () => {
    expect(disambiguate([{ value: "1", label: "Deleted User" }, { value: "2", label: "Deleted User" }, { value: "3", label: "Matt" }]).map((o) => o.label)).toEqual([
      "Deleted User (1 of 2)",
      "Deleted User (2 of 2)",
      "Matt",
    ])
  })
})

// ---------------------------------------------------------------------------
// Filters visible on the Dashboard tab (#88 AC11)
// ---------------------------------------------------------------------------

const replace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn(), refresh: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}))
jest.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: jest.fn() } }) }))

describe("DashboardClient (#88 AC11)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it("filters visible on Dashboard: the bar shows on the default tab before any other tab is visited", async () => {
    const data = dash()
    const bd: BreakdownData = breakdown()
    global.fetch = jest.fn(async (url: string) => {
      const body = url.startsWith("/api/dashboard/breakdown") ? bd : url.startsWith("/api/dashboard/cursor-cycle") ? CYCLE : { ...data, filters: {} }
      return { ok: true, status: 200, json: async () => body } as Response
    }) as unknown as typeof fetch
    const { DashboardClient } = await import("@/app/dashboard/DashboardClient")
    render(<DashboardClient />)
    await waitFor(() => expect(screen.getByRole("tab", { name: /Dashboard/ })).toHaveAttribute("data-state", "active"))
    const bar = screen.getByTestId("filter-bar")
    for (const label of ["Department", "Team", "Person", "API key", "Project", "Provider"]) {
      expect(within(bar).getByLabelText(label)).toBeInTheDocument()
    }
    expect(within(bar).getByRole("button", { name: "Clear filters" })).toBeInTheDocument()
    expect(screen.getByTestId("seats-licenses")).toBeInTheDocument()
    expect(screen.getByTestId("donut-total")).toHaveTextContent("$8,440.00")
  })

  it("the filter bar shows even when the org breakdown request fails", async () => {
    const data = dash()
    global.fetch = jest.fn(async (url: string) =>
      url.startsWith("/api/dashboard/breakdown") || url.startsWith("/api/dashboard/cursor-cycle")
        ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
        : ({ ok: true, status: 200, json: async () => ({ ...data, filters: {} }) } as Response)
    ) as unknown as typeof fetch
    const { DashboardClient } = await import("@/app/dashboard/DashboardClient")
    render(<DashboardClient />)
    await waitFor(() => expect(screen.getByTestId("filter-bar")).toBeInTheDocument())
  })
})
