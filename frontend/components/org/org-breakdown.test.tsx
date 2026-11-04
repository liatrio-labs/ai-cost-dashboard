import "@testing-library/jest-dom"
import { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiKeysTable, OrgBreakdown, OrgFilterBar, PeopleTable, ProjectsTable, sharedCoverageText } from "./org-breakdown"
import { computeBreakdown } from "@/lib/org/breakdown"
import { EMPTY_ORG, PROVIDERS, RECORDS, attributedRows } from "@/lib/org/dashboard-fixtures"
import { D, P, PE, T, orgData } from "@/lib/org/test-fixtures"
import { buildOrgIndex } from "@/lib/org/attribution"
import { toAttributedDailyRows, type CostRecordLike } from "@/lib/org/rollup"
import type { DashboardFilters } from "@/lib/dashboard-filters"
import type { BreakdownData } from "@/lib/org/breakdown"

// Issue #50: exports are captured instead of saved.
jest.mock("@/lib/csv", () => ({ ...jest.requireActual("@/lib/csv"), downloadCsv: jest.fn() }))

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
    // November contains NOW, so Change is projected vs October (issue #39).
    const eng = breakdown().department.find((d) => d.key === "dept-eng")!
    expect(eng.changePercent).toBe(112.5)
    const engChange = within(rowOf(depts, "Engineering")).getByText(`+${eng.projectedChangePercent}% proj.`)
    expect(engChange).toHaveAttribute("title", expect.stringMatching(/^Projected from 14 complete days \(through Nov 14\); actual to date \$170\.00/))
    // Two-line header: "Change" / "(projected)" (issue #41).
    const changeHead = within(depts).getAllByRole("columnheader")[3]
    expect(changeHead).toHaveTextContent("Change (projected)")
    expect(within(changeHead).getByText("Change")).toBeInTheDocument()
    expect(within(changeHead).getByText("(projected)")).toBeInTheDocument()
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

/** Issue #45: $0 keys are hidden by default; tests about every row opt in. */
async function showZeroKeys(user = userEvent.setup()) {
  await user.click(screen.getByRole("checkbox", { name: "Show $0 keys" }))
}

describe("ApiKeysTable", () => {
  it("lists provider, name, owner, team and spend", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<ApiKeysTable data={breakdown()} onFiltersChange={onChange} />)
    await showZeroKeys(user)
    const table = screen.getByRole("table", { name: "API keys" })
    const rows = within(table).getAllByTestId("key-row")
    // 3 registered keys (key_owner has no spend this month but is still listed, issue #28) + Unassigned.
    expect(rows).toHaveLength(4)
    expect(within(rowOf(table, "key_owner")).getByText("$0.00")).toBeInTheDocument()
    const team = rowOf(table, "Data pipeline key")
    for (const text of ["OpenAI API", "Alice", "Data", "$40.00"]) expect(within(team).getByText(text)).toBeInTheDocument()
    const bare = rowOf(table, "Unowned key")
    expect(within(bare).getByText("$10.00")).toBeInTheDocument()
    expect(within(rowOf(table, "Unassigned (no registered key)")).getByTestId("coverage")).toHaveTextContent(/Includes .*Anthropic/)

    await user.click(within(table).getByRole("button", { name: "Data pipeline key" }))
    expect(onChange).toHaveBeenCalledWith({ key: "k-team" })
  })
})

describe("ApiKeysTable filters (issue #45)", () => {
  const withStatus = () => {
    const d: BreakdownData = JSON.parse(JSON.stringify(breakdown()))
    for (const k of d.key_groups.flatMap((pg) => pg.projects.flatMap((g) => g.keys))) {
      if (k.label === "Data pipeline key") k.status = "active"
      if (k.label === "Unowned key") k.status = "inactive"
      if (k.label === "key_owner") Object.assign(k, { status: "active", spend_90d: 0, last_spend: "2026-05-02", provider_created_at: "2025-03-04T00:00:00Z" })
    }
    return d
  }
  const keyNames = (table: HTMLElement) => within(table).getAllByTestId("key-row").map((r) => within(r).getAllByRole("button")[0].textContent)

  it("hides $0 keys by default and shows the count", async () => {
    const user = userEvent.setup()
    render(<ApiKeysTable data={withStatus()} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "API keys" })
    expect(keyNames(table)).toEqual(["Data pipeline key", "Unowned key", "Unassigned (no registered key)"])
    expect(screen.getByTestId("key-count")).toHaveTextContent("2 of 3 keys with spend")
    await showZeroKeys(user)
    expect(keyNames(table)).toContain("key_owner")
    expect(screen.getByTestId("key-count")).toHaveTextContent("3 keys")
  })

  it("search and status chips combine and keep the order", async () => {
    const user = userEvent.setup()
    render(<ApiKeysTable data={withStatus()} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "API keys" })
    const status = screen.getByRole("group", { name: "API keys status" })
    expect(within(status).getByRole("button", { name: /^Active/ })).toHaveTextContent("Active1")
    expect(within(status).getByRole("button", { name: /^Inactive/ })).toHaveTextContent("Inactive1")
    await user.click(within(status).getByRole("button", { name: /^Inactive/ }))
    expect(keyNames(table)).toEqual(["Unowned key"])
    await user.click(within(status).getByRole("button", { name: /^All/ }))
    await user.type(screen.getByRole("searchbox", { name: "Search API keys" }), "key")
    expect(keyNames(table)).toEqual(["Data pipeline key", "Unowned key", "Unassigned (no registered key)"])
    await user.click(within(status).getByRole("button", { name: /^Active/ }))
    expect(keyNames(table)).toEqual(["Data pipeline key"])
    await user.clear(screen.getByRole("searchbox", { name: "Search API keys" }))
    await user.type(screen.getByRole("searchbox", { name: "Search API keys" }), "nomatch")
    expect(screen.getByTestId("keys-empty")).toHaveTextContent("No keys match these filters.")
    await user.click(screen.getByRole("button", { name: "Reset" }))
    expect(keyNames(table)).toHaveLength(3)
  })

  it("lists active keys with $0 in 90 days to consider revoking, with created date when known", async () => {
    const user = userEvent.setup()
    render(<ApiKeysTable data={withStatus()} onFiltersChange={() => {}} />)
    const box = screen.getByTestId("consider-revoking")
    expect(screen.getByTestId("consider-revoking-count")).toHaveTextContent("1")
    await user.click(within(box).getByText(/Consider revoking/))
    const row = within(box).getByTestId("revoke-row")
    for (const text of ["key_owner", "2026-05-02", "2025-03-04"]) expect(within(row).getByText(text)).toBeInTheDocument()
    expect(within(box).queryByRole("button")).not.toBeInTheDocument() // read-only
    await showZeroKeys(user)
    expect(within(rowOf(screen.getByRole("table", { name: "API keys" }), "key_owner")).getByTestId("key-created")).toHaveTextContent("created 2025-03-04")
  })

  it("without status or provider_created_at, shows no revoke list and no created dates", async () => {
    render(<ApiKeysTable data={breakdown()} onFiltersChange={() => {}} />)
    expect(screen.queryByTestId("consider-revoking")).not.toBeInTheDocument()
    await showZeroKeys()
    expect(screen.queryByTestId("key-created")).not.toBeInTheDocument()
    expect(within(screen.getByRole("group", { name: "API keys status" })).getByRole("button", { name: /^No status/ })).toHaveTextContent("No status3")
  })
})

describe("org table layout (issue #41)", () => {
  const clone = (d: BreakdownData): BreakdownData => JSON.parse(JSON.stringify(d))
  const keyRowCoverage = (table: HTMLElement) =>
    within(table)
      .getAllByTestId("key-row")
      .filter((r) => !within(r).queryByRole("button", { name: "Unassigned (no registered key)" }))
      .map((r) => within(r).queryByTestId("coverage")?.textContent ?? null)

  it("People: provider headers wrap the parenthetical onto line 2; plain headers stay one line", () => {
    render(<PeopleTable data={breakdown()} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "People" })
    const sortBtn = within(table).getByRole("button", { name: "Sort by Anthropic (Claude API)" })
    const label = within(sortBtn).getByTestId("header-label")
    const lines = Array.from(label.children).map((c) => c.textContent)
    expect(lines).toEqual(["Anthropic", "(Claude API)"])
    expect(label).toHaveClass("flex-col", "items-end")
    expect(within(within(table).getByRole("button", { name: "Sort by Cursor (Admin API)" })).getByTestId("header-label").children[1]).toHaveTextContent(
      "(Admin API)"
    )
    // No parenthetical: unchanged, one line.
    for (const name of ["Sort by OpenAI API", "Sort by Spend", "Sort by Name"]) {
      expect(within(within(table).getByRole("button", { name })).queryByTestId("header-label")).not.toBeInTheDocument()
    }
    expect(within(table).getByRole("button", { name: "Sort by OpenAI API" })).toHaveTextContent(/^OpenAI API$/)
  })

  it("People: sorting by a two-line provider header still works and sets aria-sort", async () => {
    const user = userEvent.setup()
    render(<PeopleTable data={breakdown()} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "People" })
    const btn = within(table).getByRole("button", { name: "Sort by Anthropic (Claude API)" })
    const th = btn.closest("th") as HTMLElement
    expect(th).toHaveClass("text-right")
    await user.click(btn)
    const names = within(table).getAllByTestId("person-row").map((r) => within(r).getAllByRole("button")[0].textContent)
    expect(names.slice(0, 2)).toEqual(["Alice", "Bob"]) // 100 then 50 on Anthropic
    expect(th).toHaveAttribute("aria-sort", "descending")
    expect(within(table).getAllByRole("columnheader")[1]).not.toHaveAttribute("aria-sort")
    await user.click(btn)
    expect(th).toHaveAttribute("aria-sort", "ascending")
    // Numeric cells stay right-aligned and nowrap.
    const cell = within(rowOf(table, "Alice")).getByText("$100.00").closest("td") as HTMLElement
    expect(cell).toHaveClass("text-right", "tabular-nums", "whitespace-nowrap")
    expect(cell).not.toHaveClass("whitespace-normal")
  })

  it("API keys: the Name cell and its note wrap instead of widening the table", async () => {
    render(<ApiKeysTable data={breakdown()} onFiltersChange={() => {}} />)
    await showZeroKeys()
    const table = screen.getByRole("table", { name: "API keys" })
    const nameCell = within(table).getByRole("button", { name: "Data pipeline key" }).closest("td") as HTMLElement
    expect(nameCell).toHaveClass("whitespace-normal", "max-w-xs")
    expect(within(nameCell).getByTestId("coverage")).toHaveClass("whitespace-normal", "break-words")
    const spendCell = within(rowOf(table, "Data pipeline key")).getByText("$40.00").closest("td") as HTMLElement
    expect(spendCell).toHaveClass("text-right", "whitespace-nowrap")
  })

  it("API keys: rows whose notes differ keep their own note", async () => {
    render(<ApiKeysTable data={breakdown()} onFiltersChange={() => {}} />)
    await showZeroKeys()
    const table = screen.getByRole("table", { name: "API keys" })
    // key_owner has no spend, so no note; the other two keep theirs.
    expect(keyRowCoverage(table)).toEqual([
      expect.stringMatching(/^Not included: Cursor \(Admin API\): per person; no API keys; Windsurf/),
      expect.stringMatching(/^Not included: Cursor/),
      null,
    ])
    expect(screen.queryByTestId("coverage-shared")).not.toBeInTheDocument()
    expect(screen.queryByTestId("coverage-group")).not.toBeInTheDocument()
  })

  it("API keys: a note every key shares shows once in the description", async () => {
    const data = clone(breakdown())
    const keys = data.key_groups.flatMap((pg) => pg.projects.flatMap((g) => g.keys))
    for (const k of keys) k.coverage = keys[0].coverage
    render(<ApiKeysTable data={data} onFiltersChange={() => {}} />)
    await showZeroKeys()
    const table = screen.getByRole("table", { name: "API keys" })
    expect(screen.getByTestId("coverage-shared")).toHaveTextContent(/^Not included for every key: Cursor \(Admin API\): per person; no API keys/)
    expect(keyRowCoverage(table)).toEqual([null, null, null])
    // The Unassigned row's "Includes" note is about different spend and stays.
    expect(within(rowOf(table, "Unassigned (no registered key)")).getByTestId("coverage")).toHaveTextContent(/^Includes /)
  })

  it("API keys: a note every key in a group shares shows once in the group row", async () => {
    const data = clone(breakdown())
    const group = data.key_groups[0].projects[0]
    for (const k of group.keys) k.coverage = group.keys[0].coverage
    const other = { ...clone(data).key_groups[0].projects[0], key: "proj-other", label: "Other project", external_id: "proj-other" }
    other.keys = [{ ...other.keys[0], key: "k-other", label: "Other key", coverage: [] }, { ...other.keys[1], key: "k-other2", label: "Other key 2" }]
    data.key_groups[0].projects.push(other)
    render(<ApiKeysTable data={data} onFiltersChange={() => {}} />)
    await showZeroKeys()
    const table = screen.getByRole("table", { name: "API keys" })
    expect(screen.queryByTestId("coverage-shared")).not.toBeInTheDocument()
    const groupRows = within(table).getAllByTestId("key-group-row")
    expect(within(groupRows[0]).getByTestId("coverage-group")).toHaveTextContent(/^Not included: Cursor \(Admin API\)/)
    expect(within(groupRows[1]).queryByTestId("coverage-group")).not.toBeInTheDocument()
    // Group 1's rows drop the note; group 2's differing rows keep their own.
    expect(keyRowCoverage(table)).toEqual([null, null, null, null, expect.stringMatching(/^Not included: Cursor/)])
  })

  it("sharedCoverageText returns the note only when every list matches", () => {
    const a = [{ provider: "cursor", providerName: "Cursor (Admin API)", note: "per person; no API keys" }]
    const b = [{ provider: "x", providerName: "X", note: "y" }]
    expect(sharedCoverageText([a, a])).toBe("Cursor (Admin API): per person; no API keys")
    expect(sharedCoverageText([a, b])).toBeNull()
    expect(sharedCoverageText([a, []])).toBeNull()
    expect(sharedCoverageText([[], []])).toBeNull()
    expect(sharedCoverageText([])).toBeNull()
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

describe("ProjectsTable (issue #24)", () => {
  it("is hidden when no spend has a project", () => {
    const { container } = render(<ProjectsTable data={breakdown()} onFiltersChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists projects with team and spend, and clicking one filters by project", async () => {
    const user = userEvent.setup()
    const org = orgData()
    org.apiKeys = org.apiKeys.map((k) => (k.external_key_id === "key_bare" ? { ...k, org_project_id: "pr-sales" } : k))
    const changes: DashboardFilters[] = []
    render(<ProjectsTable data={breakdown({}, org)} onFiltersChange={(f) => changes.push(f)} />)
    const table = screen.getByRole("table", { name: "Projects" })
    expect(within(rowOf(table, "Sales tools")).getByText("Field")).toBeInTheDocument()
    expect(within(rowOf(table, "Sales tools")).getByText("$10.00")).toBeInTheDocument()
    expect(within(rowOf(table, "Unassigned (no project)")).getByText("$240.00")).toBeInTheDocument()
    await user.click(within(table).getByRole("button", { name: "Sales tools" }))
    expect(changes).toEqual([{ project: "proj_2" }])
  })
})

// ---------------------------------------------------------------------------
// Issue #28: workspaces in the Projects table, keys under projects
// ---------------------------------------------------------------------------

describe("Projects and keys under projects (issue #28)", () => {
  const WS_KEY = "k-ws"
  const wsOrg = () => {
    const org = orgData()
    // No registered projects, so nothing but the rows can turn the table on.
    org.projects = []
    org.apiKeys = [
      ...org.apiKeys,
      { id: WS_KEY, provider_id: P.anthropic, external_key_id: "ant_key_research", name: "Research key", owner_person_id: PE.carol, team_id: null },
    ]
    return org
  }
  const wsRecord = (cost: number, ws: string, key?: string): CostRecordLike => ({
    provider_id: P.anthropic,
    timestamp: "2026-11-03T10:00:00Z",
    model_name: "claude-opus",
    cost_usd: cost,
    tokens_used: 10,
    request_count: 1,
    metadata: { attribution: { workspace_id: ws, ...(key ? { api_key_id: key } : {}), granularity: key ? "api_key" : "workspace" } },
  })
  const wsBreakdown = (filters: DashboardFilters = {}) => {
    const org = wsOrg()
    const records = [...RECORDS, wsRecord(25, "wrk_research", "ant_key_research"), wsRecord(5, "wrk_ops")]
    return computeBreakdown({
      rows: toAttributedDailyRows(records, buildOrgIndex(org)),
      org,
      providers: PROVIDERS,
      filters,
      params: { month: "2026-11" },
      now: NOW,
    })
  }

  function WsHarness({ onChange }: { onChange?: (f: DashboardFilters) => void }) {
    const [filters, setFilters] = useState<DashboardFilters>({})
    return (
      <OrgBreakdown
        data={wsBreakdown(filters)}
        onFiltersChange={(f) => {
          onChange?.(f)
          setFilters(f)
        }}
      />
    )
  }

  it("shows the Projects table when only Anthropic workspaces are reported", () => {
    render(<ProjectsTable data={wsBreakdown()} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "Projects" })
    expect(within(rowOf(table, "wrk_research")).getByText("workspace")).toBeInTheDocument()
    expect(within(rowOf(table, "wrk_research")).getByText("$25.00")).toBeInTheDocument()
    expect(within(rowOf(table, "wrk_ops")).getByText("$5.00")).toBeInTheDocument()
  })

  it("nests keys under their workspace / project, $0 keys included when shown", async () => {
    render(<ApiKeysTable data={wsBreakdown()} onFiltersChange={() => {}} />)
    await showZeroKeys()
    const table = screen.getByRole("table", { name: "API keys" })
    const headings = within(table).getAllByTestId("key-group-row").map((r) => r.textContent)
    expect(headings.some((h) => /Anthropic.*Workspace: wrk_research/.test(h ?? ""))).toBe(true)
    expect(headings.some((h) => /OpenAI API · Project: No project/.test(h ?? ""))).toBe(true)
    expect(within(rowOf(table, "Research key")).getByText("$25.00")).toBeInTheDocument()
    expect(within(rowOf(table, "key_owner")).getByText("$0.00")).toBeInTheDocument()
  })

  it("clicking a project filters the keys to that project", async () => {
    const user = userEvent.setup()
    const changes: DashboardFilters[] = []
    render(<WsHarness onChange={(f) => changes.push(f)} />)
    const projects = screen.getByRole("table", { name: "Projects" })
    await user.click(within(projects).getByRole("button", { name: "wrk_research" }))
    expect(changes.at(-1)).toEqual({ project: "wrk_research" })

    const keys = screen.getByRole("table", { name: "API keys" })
    const names = within(keys)
      .getAllByTestId("key-row")
      .map((r) => within(r).getAllByRole("cell")[1].textContent)
    expect(names.some((n) => n?.startsWith("Research key"))).toBe(true)
    expect(names.some((n) => n?.startsWith("Data pipeline key") || n?.startsWith("key_owner") || n?.startsWith("Unowned key"))).toBe(false)
    // The filter reaches the totals too: only the workspace's $25.
    const depts = screen.getByRole("table", { name: "Departments" })
    expect(within(rowOf(depts, "Unassigned")).getByText("$25.00")).toBeInTheDocument()
  })

  it("a key group heading filters by its project", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<ApiKeysTable data={wsBreakdown()} onFiltersChange={onChange} />)
    await user.click(screen.getByRole("button", { name: "Filter by workspace wrk_research" }))
    expect(onChange).toHaveBeenCalledWith({ project: "wrk_research" })
    await user.click(screen.getAllByRole("button", { name: "Filter by project No project" })[0])
    expect(onChange).toHaveBeenLastCalledWith({ project: "unassigned" })
  })

  it("lists observed workspaces in the Project filter options (Bugbot)", () => {
    const ids = wsBreakdown().options.projects.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(["wrk_research", "wrk_ops"]))
  })

  it("under a project filter, only that project's keys are listed, even when a key's spend there is only in the comparison period (Bugbot)", () => {
    const org = wsOrg()
    const records = [
      ...RECORDS,
      // October: the key spent in wrk_research; November: more in wrk_other.
      { ...wsRecord(4, "wrk_research", "ant_key_research"), timestamp: "2026-10-03T10:00:00Z" },
      wsRecord(90, "wrk_other", "ant_key_research"),
    ]
    const data = computeBreakdown({
      rows: toAttributedDailyRows(records, buildOrgIndex(org)),
      org,
      providers: PROVIDERS,
      filters: { project: "wrk_research" },
      params: { month: "2026-11" },
      now: NOW,
    })
    const groups = data.key_groups.flatMap((g) => g.projects.map((p) => ({ id: p.external_id, keys: p.keys.map((k) => k.label) })))
    expect(groups).toEqual([{ id: "wrk_research", keys: ["Research key"] }])
  })

  it("places a $0 key under its assigned project (Bugbot)", () => {
    const org = wsOrg()
    org.projects = [{ id: "op-site", provider_id: P.openai, external_project_id: "proj_site", name: "Site", team_id: null }]
    org.apiKeys = org.apiKeys.map((k) => (k.external_key_id === "key_owner" ? { ...k, org_project_id: "op-site" } : k))
    const data = computeBreakdown({ rows: attributedRows(org), org, providers: PROVIDERS, filters: {}, params: { month: "2026-11" }, now: NOW })
    const site = data.key_groups.flatMap((g) => g.projects).find((p) => p.external_id === "proj_site")
    expect(site?.keys.map((k) => k.external_key_id)).toEqual(["key_owner"])
  })

  it("without a filter, a key is placed by this period's project, not a bigger comparison-period one (Bugbot)", () => {
    const org = wsOrg()
    const records = [
      ...RECORDS,
      { ...wsRecord(80, "wrk_old", "ant_key_research"), timestamp: "2026-10-03T10:00:00Z" },
      wsRecord(10, "wrk_new", "ant_key_research"),
    ]
    const data = computeBreakdown({
      rows: toAttributedDailyRows(records, buildOrgIndex(org)),
      org,
      providers: PROVIDERS,
      filters: {},
      params: { month: "2026-11" },
      now: NOW,
    })
    const owner = data.key_groups.flatMap((g) => g.projects).find((p) => p.keys.some((k) => k.label === "Research key"))
    expect(owner?.external_id).toBe("wrk_new")
  })
})

// ---------------------------------------------------------------------------
// Issue #50: CSV export of the filtered, sorted tables
// ---------------------------------------------------------------------------

describe("Export CSV (issue #50)", () => {
  const download = jest.requireMock("@/lib/csv").downloadCsv as jest.Mock
  beforeEach(() => download.mockClear())
  /** Parses the last download; the fixtures have no quoted fields, so a plain split is safe. */
  const lastCsv = () => {
    const [filename, csv] = download.mock.calls.at(-1) as [string, string]
    const [header, ...rows] = csv.split("\r\n").map((l) => l.split(","))
    return { filename, header, rows }
  }

  it("People: exports the rows shown, in the current sort, with raw numbers and the period in the filename", async () => {
    const user = userEvent.setup()
    const data = breakdown()
    render(<PeopleTable data={data} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "People" })
    await user.click(within(table).getByRole("button", { name: "Sort by Spend" }))
    await user.click(screen.getByRole("button", { name: "Export People as CSV" }))
    const { filename, header, rows } = lastCsv()
    expect(filename).toBe("ai-cost-people-2026-11.csv")
    expect(header.slice(0, 3)).toEqual(["Name", "Spend (USD)", "Change (projected) %"])
    expect(header.slice(3)).toEqual(data.providers.map((p) => `${p.name} (USD)`))
    const shown = within(table).getAllByTestId("person-row").map((r) => within(r).getAllByRole("button")[0].textContent)
    expect(rows).toHaveLength(shown.length)
    expect(rows.map((r) => r[0])).toEqual(shown)
    const alice = rows.find((r) => r[0] === "Alice")!
    const aliceData = data.person.find((p) => p.label === "Alice")!
    expect(alice[1]).toBe(String(aliceData.cost))
    expect(alice[2]).toBe(aliceData.projectedChangePercent === null ? "" : String(aliceData.projectedChangePercent))
    const ws = data.providers.findIndex((p) => p.person === "no")
    expect(alice[3 + ws]).toBe("n/a")
  })

  it("API keys: exports exactly the key rows the filters leave, with their group", async () => {
    const user = userEvent.setup()
    render(<ApiKeysTable data={breakdown()} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "API keys" })
    const exportKeys = async () => {
      await user.click(screen.getByRole("button", { name: "Export API keys as CSV" }))
      return lastCsv()
    }
    const shown = () => within(table).getAllByTestId("key-row").map((r) => within(r).getAllByRole("button")[0].textContent)

    // Default: $0 keys hidden.
    let csv = await exportKeys()
    expect(csv.filename).toBe("ai-cost-api-keys-2026-11.csv")
    expect(csv.header).toEqual(["Provider", "Project / workspace", "Name", "Key ID", "Status", "Created", "Owner", "Team", "Spend (USD)", "Change (projected) %"])
    expect(csv.rows.map((r) => r[2])).toEqual(shown())

    await showZeroKeys(user)
    csv = await exportKeys()
    expect(csv.rows).toHaveLength(4)
    expect(csv.rows.map((r) => r[2])).toEqual(shown())
    const team = csv.rows.find((r) => r[2] === "Data pipeline key")!
    expect(team[0]).toBe("OpenAI API")
    expect(team[1]).toMatch(/^[A-Za-z ]+: /)
    expect([team[6], team[7], team[8]]).toEqual(["Alice", "Data", "40"])
    expect(csv.rows.at(-1)!.slice(0, 3)).toEqual(["", "", "Unassigned (no registered key)"])

    await user.type(screen.getByRole("searchbox", { name: "Search API keys" }), "pipeline")
    csv = await exportKeys()
    expect(shown()).toEqual(["Data pipeline key"])
    expect(csv.rows.map((r) => r[2])).toEqual(["Data pipeline key"])
  })

  it("Projects: exports every row shown", async () => {
    const user = userEvent.setup()
    const org = orgData()
    org.apiKeys = org.apiKeys.map((k) => (k.external_key_id === "key_bare" ? { ...k, org_project_id: "pr-sales" } : k))
    render(<ProjectsTable data={breakdown({}, org)} onFiltersChange={() => {}} />)
    const table = screen.getByRole("table", { name: "Projects" })
    await user.click(screen.getByRole("button", { name: "Export Projects as CSV" }))
    const { filename, header, rows } = lastCsv()
    expect(filename).toBe("ai-cost-projects-2026-11.csv")
    expect(header).toEqual(["Provider", "Project", "Kind", "Team", "Spend (USD)", "Change (projected) %"])
    expect(rows).toHaveLength(within(table).getAllByTestId("project-row").length)
    expect(rows.find((r) => r[1] === "Sales tools")!.slice(3, 5)).toEqual(["Field", "10"])
    expect(rows.find((r) => r[1] === "Unassigned (no project)")![4]).toBe("240")
  })

  it("a range period goes in the filename as its dates", async () => {
    const user = userEvent.setup()
    const data = computeBreakdown({
      rows: attributedRows(orgData()),
      org: orgData(),
      providers: PROVIDERS,
      filters: {},
      params: { start: "2026-10-01", end: "2026-10-15" },
      now: NOW,
    })
    render(<PeopleTable data={data} onFiltersChange={() => {}} />)
    await user.click(screen.getByRole("button", { name: "Export People as CSV" }))
    expect(lastCsv().filename).toBe("ai-cost-people-2026-10-01_to_2026-10-15.csv")
    expect(lastCsv().header[2]).toBe("Change %")
  })
})
