/**
 * Issue #51: the "Cursor – Bugbot/automation" row in the org breakdown UI:
 * listed before Unassigned, drills with the cursor-automation filter, stays
 * pinned above Unassigned in the People table, and is offered by the filter bar.
 */
import "@testing-library/jest-dom"
import { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OrgBreakdown, OrgFilterBar } from "./org-breakdown"
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
})
