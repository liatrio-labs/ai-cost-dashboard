import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { StructureTab } from "./OrgAdminClient"
import type { Org } from "./shared"

const LONG = "Delivery & Engagement Leads"

const org = {
  departments: [{ id: "d-ops", name: "Operations" }],
  teams: [
    { id: "t-del", name: LONG, department_id: "d-ops" },
    { id: "t-biz", name: "Business Operations", department_id: null },
  ],
  people: [{ id: "p1", team_id: "t-del" }],
  identities: [],
  apiKeys: [],
  projects: [],
  providers: [],
} as unknown as Org

describe("Departments & teams layout (issue #69)", () => {
  it("gives the Add column a fixed width and the department list the rest", () => {
    const { container } = render(<StructureTab org={org} mutate={jest.fn(async () => true)} />)
    const grid = container.firstElementChild as HTMLElement
    expect(grid).toHaveClass("grid", "md:grid-cols-[288px_minmax(0,1fr)]")
    expect(grid).not.toHaveClass("md:grid-cols-3")
    // Second column can shrink below its content so team rows truncate instead of overflowing.
    expect(grid.children[1]).toHaveClass("min-w-0")
  })

  it("keeps team name, select, Rename and delete on one row at lg+, truncating the name with a title", () => {
    render(<StructureTab org={org} mutate={jest.fn(async () => true)} />)
    const rows = screen.getAllByTestId("team-row")
    expect(rows).toHaveLength(2)

    for (const row of rows) {
      expect(row).toHaveClass("flex", "flex-wrap", "lg:flex-nowrap")
      const [name, controls] = Array.from(row.children) as HTMLElement[]
      expect(name).toHaveClass("min-w-0", "grow", "truncate")
      expect(controls).toHaveClass("shrink-0")
      expect(controls.querySelector("select")).toBeInTheDocument()
      expect(controls).toHaveTextContent("Rename")
    }

    const longName = screen.getByText(LONG).parentElement as HTMLElement
    expect(longName).toHaveAttribute("title", LONG)
    expect(longName).toHaveTextContent("1 people · 0 keys · 0 projects")
    expect(screen.getByLabelText(`Move ${LONG}`)).toHaveValue("d-ops")
    expect(screen.getByLabelText(`Delete ${LONG}`)).toBeInTheDocument()
  })
})
