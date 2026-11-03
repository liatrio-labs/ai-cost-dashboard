/**
 * Seat assignments card and Manage entries grouping (issue #26). fetch is
 * mocked; no network.
 */

import "@testing-library/jest-dom"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SeatAssignmentsCard } from "./seat-assignments"
import { ManageEntries, groupEntries } from "./manage-entries"

const PROVIDER = { id: "prov-claude-max", name: "claude-max", display_name: "Claude Ultra" }
const group = (month: string, seats: number, extra: Record<string, unknown> = {}) => ({
  provider_id: PROVIDER.id,
  month,
  seat_group_id: null,
  total_usd: seats * 200,
  total_seats: seats,
  price_per_seat: 200,
  assignments: [],
  remainder: { seats, cost_usd: seats * 200 },
  ...extra,
})
const PEOPLE = [
  { id: "p-alice", email: "alice@liatrio.com", display_name: "Alice" },
  { id: "p-bob", email: "bob@liatrio.com", display_name: "Bob" },
]

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    const body = handler(url, init)
    return { ok: true, status: 200, json: async () => body } as Response
  })
  global.fetch = fn as unknown as typeof fetch
  return fn
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe("SeatAssignmentsCard", () => {
  it("shows Claude Ultra, assigns seats and saves with the month's expected total", async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch((url, init) => {
      if (init?.method === "PUT") return { assignments: [{}, {}], remainder: { seats: 11, cost_usd: 2200 } }
      return { providers: [PROVIDER], groups: [group("2026-08", 18), group("2026-04", 14)], people: PEOPLE }
    })
    const onChanged = jest.fn()
    render(<SeatAssignmentsCard onChanged={onChanged} />)

    const tool = await screen.findByRole("combobox", { name: "Tool" })
    expect(within(tool).getByRole("option", { name: "Claude Ultra" })).toBeInTheDocument()
    expect(screen.queryByText(/Claude Max/)).not.toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Month" })).toHaveValue("2026-08")

    await user.selectOptions(screen.getByRole("combobox", { name: "Month" }), "2026-04")
    expect(screen.getByText("14 seats × $200.00 = $2,800.00")).toBeInTheDocument()

    await user.selectOptions(screen.getByRole("combobox", { name: "Add person" }), "alice@liatrio.com")
    await user.type(screen.getByRole("textbox", { name: "Add by email" }), "New.Hire@liatrio.com")
    await user.click(screen.getByRole("button", { name: /Add$/ }))
    const seats = screen.getByRole("spinbutton", { name: "Seats for new.hire@liatrio.com" })
    await user.clear(seats)
    await user.type(seats, "2")
    expect(screen.getByRole("spinbutton", { name: "Cost for new.hire@liatrio.com" })).toHaveValue(400)
    expect(screen.getByTestId("seat-totals")).toHaveTextContent("Assigned: 3 of 14 seats · $600.00 of $2,800.00")
    expect(screen.getByTestId("seat-totals")).toHaveTextContent("Unassigned remainder: 11 seats · $2,200.00")

    await user.click(screen.getByRole("button", { name: /Save assignments/ }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!
    expect(JSON.parse(String(put[1]!.body))).toEqual({
      provider_id: PROVIDER.id,
      month: "2026-04",
      expected_total_usd: 2800,
      assignments: [
        { person_email: "alice@liatrio.com", seats: 1, cost_usd: 200 },
        { person_email: "new.hire@liatrio.com", seats: 2, cost_usd: 400 },
      ],
    })
  })

  it("blocks saving when more than the month's total is assigned", async () => {
    const user = userEvent.setup()
    mockFetch(() => ({ providers: [PROVIDER], groups: [group("2026-03", 1)], people: PEOPLE }))
    render(<SeatAssignmentsCard />)
    await user.selectOptions(await screen.findByRole("combobox", { name: "Add person" }), "alice@liatrio.com")
    await user.selectOptions(screen.getByRole("combobox", { name: "Add person" }), "bob@liatrio.com")
    expect(screen.getByTestId("seat-totals")).toHaveTextContent("More than the month's total is assigned")
    expect(screen.getByRole("button", { name: /Save assignments/ })).toBeDisabled()
  })

  it("loads an existing split for editing", async () => {
    mockFetch(() => ({
      providers: [PROVIDER],
      groups: [
        group("2026-04", 14, {
          seat_group_id: "sg-1",
          assignments: [{ person_email: "bob@liatrio.com", seats: 2, cost_usd: 400 }],
          remainder: { seats: 12, cost_usd: 2400 },
        }),
      ],
      people: PEOPLE,
    }))
    render(<SeatAssignmentsCard />)
    expect(await screen.findByRole("spinbutton", { name: "Seats for bob@liatrio.com" })).toHaveValue(2)
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument()
  })
})

const ENTRY = { provider_name: "Claude Ultra", entry_type: "monthly_seats", price_per_seat: 200, note: "" }
const ENTRIES = [
  { ...ENTRY, id: "r1", month: "2026-04", cost_usd: 2050, seats: 10, seat_group_id: "sg-1", remainder: true, person_email: null },
  { ...ENTRY, id: "r2", month: "2026-04", cost_usd: 200, seats: 1, seat_group_id: "sg-1", person_email: "alice@liatrio.com" },
  { ...ENTRY, id: "r3", month: "2026-04", cost_usd: 550, seats: 3, seat_group_id: "sg-1", person_email: "bob@liatrio.com" },
  { ...ENTRY, id: "r4", month: "2026-03", cost_usd: 2400, seats: 12 },
]

describe("Manage entries grouping", () => {
  it("groups split rows under their month, people first, plain entries stay single", () => {
    const items = groupEntries(ENTRIES)
    expect(items.map((i) => i.kind)).toEqual(["group", "single"])
    const g = items[0]
    if (g.kind !== "group") throw new Error("expected group")
    expect(g.total).toBe(2800)
    expect(g.rows.map((r) => r.id)).toEqual(["r2", "r3", "r1"])
  })

  it("shows a split month as one item and deletes it as a set", async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch((url, init) => (init?.method === "DELETE" ? { deleted: 3 } : ENTRIES))
    render(<ManageEntries />)
    const item = await screen.findByTestId("seat-group")
    expect(item).toHaveTextContent("Claude Ultra · 2026-04")
    expect(item).toHaveTextContent("$2,800.00 split across 2 people")
    expect(within(item).getByText(/alice@liatrio.com/)).toBeInTheDocument()
    expect(within(item).getByText(/Unassigned · 10 seats/)).toBeInTheDocument()
    expect(within(item).queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument()

    await user.click(within(item).getByRole("button", { name: "Delete Claude Ultra 2026-04" }))
    await user.click(within(item).getByRole("button", { name: "Yes, delete" }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/entries?seat_group_id=sg-1", { method: "DELETE" })
    )
  })
})
