/**
 * Issue #51: the "Cursor – Bugbot/automation" row in the org breakdown UI:
 * listed before Unassigned, drills with the cursor-automation filter, stays
 * pinned above Unassigned in the People table, and is offered by the filter bar.
 */
import "@testing-library/jest-dom"
import { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiKeysTable, OrgBreakdown, OrgFilterBar } from "./org-breakdown"
import { computeBreakdown } from "@/lib/org/breakdown"
import { PROVIDERS, RECORDS } from "@/lib/org/dashboard-fixtures"
import { buildOrgIndex } from "@/lib/org/attribution"
import { AUTOMATION_KEY, AUTOMATION_LABEL, toAttributedDailyRows, type CostRecordLike } from "@/lib/org/rollup"
import { P, orgData } from "@/lib/org/test-fixtures"
import type { DashboardFilters } from "@/lib/dashboard-filters"

const NOW = new Date("2026-11-15T00:00:00Z")
const BUGBOT: CostRecordLike = {
  provider_id: P.cursor,
  timestamp: "2026-11-03T00:00:00.000Z",
  model_name: "bugbot",
  cost_usd: 70,
  metadata: { member_email: "unknown", attribution: { granularity: "org" } },
}
const org = orgData()
const rows = toAttributedDailyRows([...RECORDS, BUGBOT], buildOrgIndex(org))
const breakdown = (filters: DashboardFilters = {}) =>
  computeBreakdown({ rows, org, providers: PROVIDERS, filters, params: { month: "2026-11" }, now: NOW })

function Harness({ onChange }: { onChange: (f: DashboardFilters) => void }) {
  const [filters, setFilters] = useState<DashboardFilters>({})
  return (
    <OrgBreakdown
      data={breakdown(filters)}
      onFiltersChange={(f) => {
        onChange(f)
        setFilters(f)
      }}
    />
  )
}

const names = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).queryAllByRole("button")[0]?.textContent ?? within(r).getAllByRole("cell")[0].textContent)

describe("Cursor – Bugbot/automation row (issue #51)", () => {
  it("is its own department row before Unassigned and drills like any other", async () => {
    const user = userEvent.setup()
    const changes: DashboardFilters[] = []
    render(<Harness onChange={(f) => changes.push(f)} />)
    const depts = screen.getByRole("table", { name: "Departments" })
    expect(names(depts).slice(-2)).toEqual([AUTOMATION_LABEL, "Unassigned"])
    const autoRow = within(depts).getByRole("button", { name: AUTOMATION_LABEL }).closest("tr") as HTMLElement
    expect(within(autoRow).getByText("$70.00")).toBeInTheDocument()
    // Unassigned keeps its $30 (Windsurf 20 + openai key_bare 10), not the Cursor $70.
    const unRow = within(depts).getByRole("button", { name: "Unassigned" }).closest("tr") as HTMLElement
    expect(within(unRow).getByText("$30.00")).toBeInTheDocument()

    await user.click(within(depts).getByRole("button", { name: AUTOMATION_LABEL }))
    expect(changes.at(-1)).toEqual({ department: AUTOMATION_KEY })
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(AUTOMATION_LABEL)
    const teams = screen.getByRole("table", { name: "Teams" })
    expect(names(teams)).toEqual([AUTOMATION_LABEL, "Unassigned"])
  })

  it("filter bar offers the line, and keeps department + team automation together", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const { rerender } = render(<OrgFilterBar data={breakdown()} filters={{}} onFiltersChange={onChange} />)
    const deptOpts = within(screen.getByLabelText("Department")).getAllByRole("option").map((o) => o.textContent)
    expect(deptOpts.slice(-2)).toEqual([AUTOMATION_LABEL, "Unassigned"])
    expect(within(screen.getByLabelText("Project")).getAllByRole("option").map((o) => o.textContent)).not.toContain(AUTOMATION_LABEL)
    await user.selectOptions(screen.getByLabelText("Department"), AUTOMATION_KEY)
    expect(onChange).toHaveBeenLastCalledWith({ department: AUTOMATION_KEY })

    const f = { department: AUTOMATION_KEY }
    rerender(<OrgFilterBar data={breakdown(f)} filters={f} onFiltersChange={onChange} />)
    await user.selectOptions(screen.getByLabelText("Team"), AUTOMATION_KEY)
    expect(onChange).toHaveBeenLastCalledWith({ department: AUTOMATION_KEY, team: AUTOMATION_KEY })
  })

  it("no automation option when there is no such spend", () => {
    const plain = computeBreakdown({ rows: toAttributedDailyRows(RECORDS, buildOrgIndex(org)), org, providers: PROVIDERS, filters: {}, params: { month: "2026-11" }, now: NOW })
    render(<OrgFilterBar data={plain} filters={{}} onFiltersChange={jest.fn()} />)
    expect(within(screen.getByLabelText("Department")).getAllByRole("option").map((o) => o.textContent)).not.toContain(AUTOMATION_LABEL)
  })

  it("API keys table lists the automation spend row, so it still sums to the total (Bugbot review)", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const d = breakdown()
    render(<ApiKeysTable data={d} onFiltersChange={onChange} />)
    const btn = screen.getByRole("button", { name: AUTOMATION_LABEL })
    const row = btn.closest("tr") as HTMLElement
    expect(within(row).getByText("$70.00")).toBeInTheDocument()
    expect(within(row).getByTestId("coverage")).toHaveTextContent(/^Includes /)
    expect(screen.getByRole("button", { name: "Unassigned (no registered key)" })).toBeInTheDocument()
    await user.click(btn)
    expect(onChange).toHaveBeenLastCalledWith({ key: AUTOMATION_KEY })
    // Under key=cursor-automation the card shows the row, not "empty".
    render(<ApiKeysTable data={breakdown({ key: AUTOMATION_KEY })} onFiltersChange={jest.fn()} />)
    expect(screen.queryAllByTestId("keys-empty")).toHaveLength(0)
  })

  it("department row's coverage note reads Includes, not Not included (Bugbot review)", () => {
    render(<Harness onChange={jest.fn()} />)
    const depts = screen.getByRole("table", { name: "Departments" })
    const row = within(depts).getByRole("button", { name: AUTOMATION_LABEL }).closest("tr") as HTMLElement
    expect(within(row).getByTestId("coverage")).toHaveTextContent(/^Includes Cursor/)
  })

  it("person automation / unassigned are dropped when the parent can't contain them (Bugbot review)", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const f1 = { person: AUTOMATION_KEY }
    const { rerender } = render(<OrgFilterBar data={breakdown(f1)} filters={f1} onFiltersChange={onChange} />)
    await user.selectOptions(screen.getByLabelText("Department"), "unassigned")
    expect(onChange).toHaveBeenLastCalledWith({ department: "unassigned" })

    // (Options from unfiltered data: e.g. a shared link with both set.)
    const f2 = { person: "unassigned" }
    rerender(<OrgFilterBar data={breakdown()} filters={f2} onFiltersChange={onChange} />)
    await user.selectOptions(screen.getByLabelText("Department"), AUTOMATION_KEY)
    expect(onChange).toHaveBeenLastCalledWith({ department: AUTOMATION_KEY })

    // Kept when compatible.
    rerender(<OrgFilterBar data={breakdown(f1)} filters={f1} onFiltersChange={onChange} />)
    await user.selectOptions(screen.getByLabelText("Department"), AUTOMATION_KEY)
    expect(onChange).toHaveBeenLastCalledWith({ department: AUTOMATION_KEY, person: AUTOMATION_KEY })

    // Under an automation department the Person select has no Unassigned option.
    const f3 = { department: AUTOMATION_KEY }
    rerender(<OrgFilterBar data={breakdown(f3)} filters={f3} onFiltersChange={onChange} />)
    const opts = within(screen.getByLabelText("Person")).getAllByRole("option").map((o) => o.textContent)
    expect(opts).toContain(AUTOMATION_LABEL)
    expect(opts).not.toContain("Unassigned")
  })

  it("filter bar renders before the breakdown loads (data null), e.g. a shared filtered link (Bugbot review)", () => {
    render(<OrgFilterBar data={null} filters={{ department: AUTOMATION_KEY, person: "unassigned" }} onFiltersChange={jest.fn()} />)
    const dept = within(screen.getByLabelText("Department")).getAllByRole("option").map((o) => o.textContent)
    // The selected automation value still has a label while loading.
    expect(dept).toContain(AUTOMATION_LABEL)
    expect(screen.getByLabelText("Person")).toBeInTheDocument()
  })
})
