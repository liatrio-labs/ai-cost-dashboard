import "@testing-library/jest-dom"
import { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OrgView } from "../org-view"
import { ApiKeysTable } from "../api-keys-table"
import { PeopleTable } from "../people-table"
import { OrgFilterBar } from "../org-filter-bar"
import { buildBreakdown } from "@/lib/dashboard/breakdown"
import type { DashboardFilters } from "@/lib/dashboard/filters"
import { attributedRows, emptyOrg, providerRows } from "@/lib/dashboard/test-fixtures"
import { orgData, T } from "@/lib/org/test-fixtures"

const build = (filters: DashboardFilters = {}, org = orgData()) =>
  buildBreakdown(attributedRows(org), org, providerRows, { month: "2026-11" }, filters)

function Harness({ initial = {} }: { initial?: DashboardFilters }) {
  const [filters, setFilters] = useState<DashboardFilters>(initial)
  return <OrgView data={build(filters)} onNavigate={setFilters} />
}

const rowsOf = (testId: string) =>
  within(screen.getByTestId(testId))
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell").map((c) => c.textContent))

describe("OrgView drill-down", () => {
  it("drills department -> team -> person -> provider x model, with breadcrumbs", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect(rowsOf("drilldown-department").map((r) => [r[0], r[1], r[2]])).toEqual([
      ["Engineering", "$190.00", "+90%"],
      ["Sales", "$65.00", "new"],
      ["UnassignedIncludes Windsurf: org-level only (flat seat cost)", "$92.00", "+84%"],
    ])

    await user.click(within(screen.getByTestId("drilldown-department")).getByRole("button", { name: "Engineering" }))
    expect(rowsOf("drilldown-team").map((r) => [r[0], r[1]])).toEqual([
      ["Platform", "$100.00"],
      ["Data", "$90.00"],
      ["Unassigned", "$0.00"],
    ])

    await user.click(within(screen.getByTestId("drilldown-team")).getByRole("button", { name: "Data" }))
    expect(rowsOf("drilldown-person").map((r) => [r[0], r[1]])).toEqual([
      ["Alice", "$60.00"],
      ["Dave", "$30.00"],
      ["Unassigned", "$0.00"],
    ])
    // Team -> API keys: only the Data team's key, plus Unassigned.
    expect(rowsOf("api-keys-table").map((r) => [r[1], r[4]])).toEqual([
      ["Data pipeline key", "$60.00"],
      ["UnassignedIncludes Cursor: per member", "$30.00"],
    ])

    await user.click(within(screen.getByTestId("drilldown-person")).getByRole("button", { name: "Alice" }))
    expect(rowsOf("drilldown-detail")).toEqual([["OpenAI API", "gpt-5", "$60.00"]])

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" })
    expect(crumbs).toHaveTextContent("All departments")
    expect(crumbs).toHaveTextContent("Engineering")
    expect(within(crumbs).getByText("Alice")).toHaveAttribute("aria-current", "page")

    await user.click(within(crumbs).getByRole("button", { name: "All departments" }))
    expect(screen.getByTestId("drilldown-department")).toBeInTheDocument()
  })

  it("can drill into the Unassigned department", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(within(screen.getByTestId("drilldown-department")).getByRole("button", { name: "Unassigned" }))
    expect(rowsOf("drilldown-team").map((r) => r[0])).toEqual(["Orphan", expect.stringMatching(/^Unassigned/)])
  })

  it("renders everything as Unassigned with no org structure", () => {
    const org = emptyOrg()
    render(<OrgView data={build({}, org)} onNavigate={() => {}} />)
    expect(rowsOf("drilldown-department").map((r) => [r[1]])).toEqual([["$347.00"]])
    expect(rowsOf("people-table")).toHaveLength(1)
    expect(rowsOf("api-keys-table")[0][4]).toBe("$347.00")
  })
})

describe("ApiKeysTable", () => {
  it("lists provider, name, owner, team and spend, with Unassigned last", () => {
    render(<ApiKeysTable apiKeys={build().apiKeys} />)
    expect(rowsOf("api-keys-table").map((r) => r.slice(0, 5))).toEqual([
      ["OpenAI API", "Data pipeline key", "Alice", "Data", "$60.00"],
      ["OpenAI API", "key_owner", "Bob", "—", "$25.00"],
      ["OpenAI API", "Unowned key", "—", "—", "$5.00"],
      ["", "UnassignedIncludes Cursor: per member; Windsurf: org-level only (flat seat cost)", "", "", "$257.00"],
    ])
  })
})

describe("PeopleTable", () => {
  it("sorts by spend and shows n/a for providers without person coverage", async () => {
    const user = userEvent.setup()
    const b = build()
    render(<PeopleTable people={b.people} providers={b.providers} />)
    const header = within(screen.getByTestId("people-table")).getAllByRole("columnheader").map((h) => h.textContent)
    expect(header).toEqual(["Person", "Team", "Total", "Change", "Anthropic API", "OpenAI API", "Cursor", "Windsurf"])

    let rows = rowsOf("people-table")
    expect(rows.map((r) => r[0])).toEqual(["Alicealice@liatrio.com", "Bobbob@liatrio.com", "Davedave@liatrio.com", "carol@liatrio.com", "Erinerin@liatrio.com", "Unassigned"])
    // Alice: Anthropic $100, OpenAI $60 (via key owner), no Cursor, Windsurf n/a.
    expect(rows[0].slice(4)).toEqual(["$100.00", "$60.00", "—", "n/a"])
    expect(rows[5].slice(4)).toEqual(["$10.00", "$12.00", "—", "$50.00"])

    await user.click(screen.getByRole("button", { name: "Total" }))
    rows = rowsOf("people-table")
    expect(rows.map((r) => r[2])).toEqual(["$8.00", "$12.00", "$30.00", "$65.00", "$160.00", "$72.00"])

    await user.click(screen.getByRole("button", { name: "Cursor" }))
    expect(rowsOf("people-table")[0][0]).toMatch(/^Dave/)
  })
})

describe("OrgFilterBar", () => {
  it("narrows team options by department and resets child filters", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const b = build({ department: "dept-eng" })
    render(<OrgFilterBar options={b.options} filters={{ department: "dept-eng", team: T.data }} onChange={onChange} />)
    const teams = within(screen.getByLabelText("Team")).getAllByRole("option").map((o) => o.textContent)
    expect(teams).toEqual(["All", "Data", "Platform", "Unassigned"])
    await user.selectOptions(screen.getByLabelText("Department"), "dept-sales")
    expect(onChange).toHaveBeenCalledWith({ department: "dept-sales" })
    await user.click(screen.getByRole("button", { name: /clear filters/i }))
    expect(onChange).toHaveBeenLastCalledWith({})
  })

  it("lists unteamed people and keys under the Unassigned department", () => {
    const b = build()
    render(<OrgFilterBar options={b.options} filters={{ department: "unassigned" }} onChange={() => {}} />)
    const opts = (label: string) => within(screen.getByLabelText(label)).getAllByRole("option").map((o) => o.textContent)
    // Orphan team (no department) plus unteamed Carol; Erin is on Orphan.
    expect(opts("Team")).toEqual(["All", "Orphan", "Unassigned"])
    expect(opts("Person")).toEqual(["All", "carol@liatrio.com", "Erin", "Unassigned"])
    expect(opts("API key")).toEqual(["All", "key_owner (OpenAI API)", "Unowned key (OpenAI API)", "Unassigned"])
  })
})
