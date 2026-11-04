import "@testing-library/jest-dom"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BulkTeamBar, CsvImportCard, SelectAllCheckbox, useSelection } from "./bulk"
import type { Org } from "./shared"

const org: Org = {
  departments: [{ id: "d-eng", name: "Engineering" }],
  teams: [
    { id: "team-web", name: "Web", department_id: "d-eng" },
    { id: "team-data", name: "Data", department_id: null },
  ],
  people: [],
  identities: [],
  apiKeys: [],
  projects: [],
  providers: [],
} as unknown as Org

function Harness({ rows, onAssign }: { rows: string[]; onAssign: (ids: string[], team: string | null) => Promise<boolean> }) {
  const sel = useSelection(rows)
  return (
    <div>
      <SelectAllCheckbox label="Select all" all={sel.allSelected} some={sel.someSelected} onChange={sel.setAll} />
      {rows.map((r) => (
        <input key={r} type="checkbox" aria-label={`Select ${r}`} checked={sel.selected.has(r)} onChange={(e) => sel.toggle(r, e.target.checked)} />
      ))}
      <BulkTeamBar org={org} count={sel.selected.size} noun="person" plural="people" onAssign={(t) => onAssign([...sel.selected], t)} onClear={sel.clear} />
    </div>
  )
}

describe("bulk team assignment UI (#43)", () => {
  it("select-all covers the shown rows, and Assign team sends them with the chosen team, then clears", async () => {
    const user = userEvent.setup()
    const onAssign = jest.fn(async () => true)
    const { rerender } = render(<Harness rows={["a", "b", "c"]} onAssign={onAssign} />)
    expect(screen.queryByRole("region", { name: "Bulk assign people" })).toBeNull()

    await user.click(screen.getByRole("checkbox", { name: "Select all" }))
    const bar = screen.getByRole("region", { name: "Bulk assign people" })
    expect(bar).toHaveTextContent("3 people selected")

    // A row filtered out is no longer selected.
    rerender(<Harness rows={["a", "c"]} onAssign={onAssign} />)
    expect(bar).toHaveTextContent("2 people selected")

    await user.selectOptions(within(bar).getByRole("combobox", { name: "Team for selected people" }), "team-web")
    await user.click(within(bar).getByRole("button", { name: "Assign team: Web" }))
    expect(onAssign).toHaveBeenCalledWith(["a", "c"], "team-web")
    expect(screen.queryByRole("region", { name: "Bulk assign people" })).toBeNull()
  })

  it("the CSV card previews (dry run) first, then applies what was previewed", async () => {
    const user = userEvent.setup()
    const preview = {
      dry_run: true,
      kind: "people",
      counts: { rows: 3, matched: 2, changes: 1, unchanged: 1, unmatched: 1, unknown_team: 0, invalid: 0 },
      unknown_teams: [],
      rows: [
        { line: 1, input: "a@x.com", status: "change", team: { id: "team-web", name: "Web", department_id: "d-eng", department_name: "Engineering" }, current_team_id: null },
        { line: 2, input: "b@x.com", status: "unchanged", team: null },
        { line: 3, input: "nobody@x.com", status: "unmatched", message: "No person with this email", team: null },
      ],
    }
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => preview })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...preview, dry_run: false, applied: 1, created_teams: [] }) })
    global.fetch = fetchMock as unknown as typeof fetch
    const onApplied = jest.fn(async () => undefined)
    render(<CsvImportCard org={org} onApplied={onApplied} />)

    await user.type(screen.getByRole("textbox", { name: "CSV" }), "a@x.com,Web")
    await user.click(screen.getByRole("button", { name: "Preview (dry run)" }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: "people", csv: "a@x.com,Web", confirm: false, create_teams: false })
    expect(screen.getByTestId("csv-counts")).toHaveTextContent("3 row(s): 2 matched (1 to change, 1 unchanged) · 1 unmatched")
    // Unchanged rows are hidden; the unmatched one is listed.
    expect(screen.getAllByTestId("csv-row").map((r) => r.textContent)).toEqual([
      expect.stringContaining("a@x.com"),
      expect.stringContaining("nobody@x.com"),
    ])

    await user.click(screen.getByRole("button", { name: "Apply 1 change" }))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ confirm: true })
    expect(onApplied).toHaveBeenCalled()
    expect(screen.getByText(/Applied 1 change/)).toBeInTheDocument()
  })

  it("a thrown request (network failure) re-enables Assign team and keeps the selection", async () => {
    const user = userEvent.setup()
    const onAssign = jest.fn<Promise<boolean>, [string[], string | null]>().mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce(true)
    render(<Harness rows={["a"]} onAssign={onAssign} />)
    await user.click(screen.getByRole("checkbox", { name: "Select a" }))
    const button = screen.getByRole("button", { name: "Assign team: Unassigned" })
    await user.click(button)
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to fetch")
    expect(button).toBeEnabled()
    await user.click(button)
    expect(onAssign).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("region", { name: "Bulk assign people" })).toBeNull()
  })

  it("an error from a previous attempt is gone once the selection is cleared", async () => {
    const user = userEvent.setup()
    const onAssign = jest.fn<Promise<boolean>, [string[], string | null]>().mockRejectedValue(new Error("Failed to fetch"))
    render(<Harness rows={["a"]} onAssign={onAssign} />)
    await user.click(screen.getByRole("checkbox", { name: "Select a" }))
    await user.click(screen.getByRole("button", { name: "Assign team: Unassigned" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to fetch")
    await user.click(screen.getByRole("button", { name: "Clear" }))
    await user.click(screen.getByRole("checkbox", { name: "Select a" }))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("a thrown CSV request shows the error and re-enables Preview", async () => {
    const user = userEvent.setup()
    global.fetch = jest.fn().mockRejectedValue(new Error("Failed to fetch")) as unknown as typeof fetch
    render(<CsvImportCard org={org} onApplied={async () => undefined} />)
    await user.type(screen.getByRole("textbox", { name: "CSV" }), "x")
    await user.click(screen.getByRole("button", { name: "Preview (dry run)" }))
    expect(screen.getByText("Request failed: Failed to fetch")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview (dry run)" })).toBeEnabled()
  })

  it("editing the CSV discards the preview so an unpreviewed CSV can't be applied", async () => {
    const user = userEvent.setup()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ dry_run: true, kind: "people", counts: { rows: 0, matched: 0, changes: 0, unchanged: 0, unmatched: 0, unknown_team: 0, invalid: 0 }, unknown_teams: [], rows: [] }),
    }) as unknown as typeof fetch
    render(<CsvImportCard org={org} onApplied={async () => undefined} />)
    await user.type(screen.getByRole("textbox", { name: "CSV" }), "x")
    await user.click(screen.getByRole("button", { name: "Preview (dry run)" }))
    expect(screen.getByRole("button", { name: /Apply/ })).toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "CSV" }), "y")
    expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull()
  })
})
