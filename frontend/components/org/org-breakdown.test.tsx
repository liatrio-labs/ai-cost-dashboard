import "@testing-library/jest-dom"
import { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiKeysTable, OrgBreakdown, OrgFilterBar, PeopleTable } from "./org-breakdown"
import { computeBreakdown } from "@/lib/org/breakdown"
import { EMPTY_ORG, PROVIDERS, attributedRows } from "@/lib/org/dashboard-fixtures"
import { D, PE, T, orgData } from "@/lib/org/test-fixtures"
import type { DashboardFilters } from "@/lib/dashboard-filters"

const NOW = new Date("2026-11-15T00:00:00Z")
const breakdown = (filters: DashboardFilters = {}, org = orgData()) =>
  computeBreakdown({ rows: attributedRows(org), org, providers: PROVIDERS, filters, params: { month: "2026-11" }, now: NOW })

/** Stands in for the URL: each filter change recomputes from fixtures. */
function Harness({ initial = {}, onChange }: { initial?: DashboardFilters; onChange?: (f: DashboardFilters) => void }) {
  const [filters, setFilters] = useState<DashboardFilters>(initial)
  const update = (f: DashboardFilters) => {
    onChange?.(f)
    setFilters(f)
  }
  return <OrgBreakdown data={breakdown(filters)} onFiltersChange={update} />
}

const rowOf = (table: HTMLElement, name: string) =>
  within(table).getByRole("button", { name }).closest("tr") as HTMLElement

describe("OrgBreakdown drill-down", () => {
  it("drills department -> team -> person -> provider x model, with breadcrumbs", async () => {
    const user = userEvent.setup()
    const changes: DashboardFilters[] = []
    render(<Harness onChange={(f) => changes.push(f)} />)

    // Departments, with Unassigned and coverage notes.
    const depts = screen.getByRole("table", { name: "Departments" })
    expect(within(rowOf(depts, "Engineering")).getByText("$170.00")).toBeInTheDocument()
    expect(within(rowOf(depts, "Engineering")).getByText("+112.5%")).toBeInTheDocument()
    expect(within(rowOf(depts, "Unassigned")).getByText("$30.00")).toBeInTheDocument()
    expect(within(rowOf(depts, "Engineering")).getByTestId("coverage")).toHaveTextContent(
      "Not included: Windsurf (CascadeAnalytics): org-level only"
    )

    await user.click(within(depts).getByRole("button", { name: "Engineering" }))
    expect(changes.at(-1)).toEqual({ department: D.eng })
    const teams = screen.getByRole("table", { name: "Teams" })
    expect(within(teams).getByRole("button", { name: "Platform" })).toBeInTheDocument()
    expect(within(teams).queryByRole("button", { name: "Field" })).not.toBeInTheDocument()
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("All spendEngineering")

    await user.click(within(teams).getByRole("button", { name: "Data" }))
    expect(changes.at(-1)).toEqual({ department: D.eng, team: T.data })
    const people = screen.getByRole("table", { name: "People" })
    const spend = (name: string) => within(rowOf(people, name)).getAllByRole("cell")[1]
    expect(spend("Alice")).toHaveTextContent("$40.00")
    expect(spend("Dave")).toHaveTextContent("$30.00")
    expect(within(people).queryByRole("button", { name: "Bob" })).not.toBeInTheDocument()

    await user.click(within(people).getByRole("button", { name: "Alice" }))
    const detail = screen.getByRole("table", { name: "Provider and model detail" })
    expect(within(detail).getByText("gpt-5")).toBeInTheDocument()
    expect(within(detail).queryByText("claude-opus")).not.toBeInTheDocument() // Alice's Anthropic spend isn't on team Data

    // Breadcrumb back to the department.
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" })
    expect(within(crumbs).getByText("Alice")).toHaveAttribute("aria-current", "page")
    await user.click(within(crumbs).getByRole("button", { name: "Engineering" }))
    expect(changes.at(-1)).toEqual({ department: D.eng })
    expect(screen.getByRole("table", { name: "Teams" })).toBeInTheDocument()

    await user.click(within(crumbs).getByRole("button", { name: "All spend" }))
    expect(screen.getByRole("table", { name: "Departments" })).toBeInTheDocument()
  })
})

describe("PeopleTable", () => {
  it("shows per-provider columns, n/a for providers without people, and sorts", async () => {
    const user = userEvent.setup()
    render(<PeopleTable data={breakdown()} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "People" })
    const names = () => within(table).getAllByTestId("person-row").map((r) => within(r).getAllByRole("button")[0].textContent)

    expect(names()).toEqual(["Alice", "Bob", "Dave", "carol@liatrio.com", "Unassigned"])
    const alice = rowOf(table, "Alice")
    expect(within(alice).getByText("$100.00")).toBeInTheDocument() // Anthropic column
    expect(within(alice).getByText("n/a")).toHaveAttribute("title", expect.stringMatching(/Windsurf.*org-level only/))

    await user.click(within(table).getByRole("button", { name: "Sort by Spend" }))
    expect(names()).toEqual(["carol@liatrio.com", "Dave", "Bob", "Alice", "Unassigned"])
    await user.click(within(table).getByRole("button", { name: "Sort by Name" }))
    expect(names()[0]).toBe("Dave")
  })
})

describe("ApiKeysTable", () => {
  it("lists provider, name, owner, team and spend", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<ApiKeysTable data={breakdown()} onFiltersChange={onChange} />)
    const table = screen.getByRole("table", { name: "API keys" })
    const rows = within(table).getAllByTestId("key-row")
    expect(rows).toHaveLength(3)
    const team = rowOf(table, "Data pipeline key")
    for (const text of ["OpenAI API", "Alice", "Data", "$40.00"]) expect(within(team).getByText(text)).toBeInTheDocument()
    const bare = rowOf(table, "Unowned key")
    expect(within(bare).getByText("$10.00")).toBeInTheDocument()
    expect(within(rowOf(table, "Unassigned (no registered key)")).getByTestId("coverage")).toHaveTextContent(/Includes .*Anthropic/)

    await user.click(within(table).getByRole("button", { name: "Data pipeline key" }))
    expect(onChange).toHaveBeenCalledWith({ key: "k-team" })
  })
})

describe("with no org structure", () => {
  it("renders a single Unassigned row per table", () => {
    const data = breakdown({}, EMPTY_ORG)
    render(<OrgBreakdown data={data} onFiltersChange={() => {}} />)
    const depts = screen.getByRole("table", { name: "Departments" })
    expect(within(depts).getAllByRole("row")).toHaveLength(2) // header + Unassigned
    expect(within(rowOf(depts, "Unassigned")).getByText("$250.00")).toBeInTheDocument()
  })
})

describe("OrgFilterBar", () => {
  it("combines filters and narrows team options to the department", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const { rerender } = render(<OrgFilterBar data={breakdown()} filters={{}} onFiltersChange={onChange} />)
    await user.selectOptions(screen.getByLabelText("Department"), D.eng)
    expect(onChange).toHaveBeenLastCalledWith({ department: D.eng })

    rerender(<OrgFilterBar data={breakdown()} filters={{ department: D.eng }} onFiltersChange={onChange} />)
    const teamOpts = within(screen.getByLabelText("Team")).getAllByRole("option").map((o) => o.textContent)
    // No "Unassigned" team under a specific department: it could never match.
    expect(teamOpts).toEqual(["All", "Platform", "Data"])
    await user.selectOptions(screen.getByLabelText("Provider"), "openai")
    expect(onChange).toHaveBeenLastCalledWith({ department: D.eng, provider: "openai" })

    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(onChange).toHaveBeenLastCalledWith({})
  })
})

describe("OrgFilterBar child filters", () => {
  const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole("option").map((o) => o.textContent)

  it("drops a team and person that the new department excludes", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<OrgFilterBar data={breakdown()} filters={{ department: D.eng, team: T.data, person: PE.dave }} onFiltersChange={onChange} />)
    await user.selectOptions(screen.getByLabelText("Department"), D.sales)
    expect(onChange).toHaveBeenLastCalledWith({ department: D.sales })
  })

  it("keeps children that still fit the new parent", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<OrgFilterBar data={breakdown()} filters={{ team: T.data, person: PE.dave }} onFiltersChange={onChange} />)
    await user.selectOptions(screen.getByLabelText("Department"), D.eng)
    expect(onChange).toHaveBeenLastCalledWith({ team: T.data, person: PE.dave, department: D.eng })
    await user.selectOptions(screen.getByLabelText("Team"), T.platform)
    expect(onChange).toHaveBeenLastCalledWith({ team: T.platform })
  })

  it("scopes people to the department and lists department-less teams under Unassigned", () => {
    const { rerender } = render(<OrgFilterBar data={breakdown()} filters={{ department: D.eng }} onFiltersChange={() => {}} />)
    expect(options("Person")).toEqual(["All", "Alice", "Dave", "Unassigned"])
    rerender(<OrgFilterBar data={breakdown()} filters={{ department: "unassigned" }} onFiltersChange={() => {}} />)
    expect(options("Team")).toEqual(["All", "Orphan", "Unassigned"])
  })
})

describe("OrgFilterBar person scope follows where spend lands", () => {
  it("keeps a person whose spend reaches the team through an API key", async () => {
    // Alice's home team is Platform, but her Data pipeline key spend is on Data.
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<OrgFilterBar data={breakdown()} filters={{ team: T.data, person: PE.alice }} onFiltersChange={onChange} />)
    expect(within(screen.getByLabelText("Person")).getAllByRole("option").map((o) => o.textContent)).toContain("Alice")
    await user.selectOptions(screen.getByLabelText("Department"), D.eng)
    expect(onChange).toHaveBeenLastCalledWith({ team: T.data, person: PE.alice, department: D.eng })
  })

  it("lets Unassigned team be chosen when the department is Unassigned", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<OrgFilterBar data={breakdown()} filters={{ department: "unassigned" }} onFiltersChange={onChange} />)
    await user.selectOptions(screen.getByLabelText("Team"), "unassigned")
    expect(onChange).toHaveBeenLastCalledWith({ department: "unassigned", team: "unassigned" })
  })
})
