/**
 * Cursor seats under Seat assignments on /admin (migration 026, issue #92):
 * the "migration 026 not applied" notice with seat selects disabled, the
 * billing cycle being edited (20th to 20th, issue #82), the cycle summary,
 * and a per-person seat change from the card's seat list.
 */

import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CursorSeatAssignmentsCard, CursorSeatsCard, useCursorSeats, type SeatPerson } from "./cursor-seats"

const people: SeatPerson[] = [{ id: "p1", email: "p1@liatrio.com", display_name: "Pat" }]

const NOV_CYCLE = { key: "2026-11", start: "2026-11-20", end: "2026-12-20", label: "Nov 20 – Dec 20, 2026" }
const OCT_CYCLE = { key: "2026-10", start: "2026-10-20", end: "2026-11-20", label: "Oct 20 – Nov 20, 2026" }

const state = (over: Record<string, unknown> = {}) => ({
  available: true,
  notice: null,
  currentMonth: "2026-11",
  cycle: NOV_CYCLE,
  cycleInProgress: OCT_CYCLE,
  rates: { standard: 40, premium: 80, free: 0 },
  rateHistory: [],
  current: { p1: "standard" },
  assignmentCount: 1,
  summary: { month: "2026-11", cycle: NOV_CYCLE, counts: { standard: 1, premium: 0, free: 0, none: 0 }, rates: { standard: 40, premium: 80, free: 0 }, total_usd: 40 },
  recurringConflict: false,
  ...over,
})

function Harness() {
  const seats = useCursorSeats(0)
  return <CursorSeatsCard seats={seats} people={people} />
}

const fetchMock = jest.fn()
beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})
const reply = (body: unknown, status = 200) => Promise.resolve({ ok: status < 300, status, json: async () => body })

describe("CursorSeatsCard", () => {
  it("shows the migration 026 notice and disables seat selects when it isn't applied", async () => {
    fetchMock.mockImplementation(() =>
      reply(state({ available: false, notice: "Cursor seat types need database migration 026", current: {}, summary: null, assignmentCount: 0 }))
    )
    render(<Harness />)
    expect(await screen.findByText(/migration 026/)).toBeInTheDocument()
    // No editable seat select while 026 is missing.
    expect(screen.queryByLabelText("Cursor seat for p1@liatrio.com")).not.toBeInTheDocument()
  })

  it("shows the billing cycle being edited (Nov 20 – Dec 20) and the cycle in progress", async () => {
    fetchMock.mockImplementation(() => reply(state()))
    render(<Harness />)
    const cycle = await screen.findByTestId("cursor-seat-cycle")
    expect(cycle).toHaveTextContent("Editing cycle Nov 20 – Dec 20, 2026 (counts in Nov 2026)")
    expect(cycle).toHaveTextContent("Oct 20 – Nov 20, 2026, was billed in Oct 2026")
    expect(screen.getByTestId("cursor-seat-summary")).toHaveTextContent("Nov 20 – Dec 20, 2026: 1 Standard")
    expect(screen.getByLabelText("Cursor seat for p1@liatrio.com")).toHaveAttribute("title", expect.stringContaining("Nov 20 – Dec 20, 2026 cycle on"))
  })

  it("shows the cycle's seat total and saves a person's seat type", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? reply(state({ current: { p1: "premium" }, summary: { month: "2026-11", cycle: NOV_CYCLE, counts: { standard: 0, premium: 1, free: 0, none: 0 }, rates: { standard: 40, premium: 80, free: 0 }, total_usd: 80 } }))
        : reply(state())
    )
    render(<Harness />)
    expect(await screen.findByTestId("cursor-seat-summary")).toHaveTextContent("1 Standard · 0 Premium · 0 Free = $40.00")
    await waitFor(() => expect(screen.getByLabelText("Premium monthly rate")).toHaveValue(80))
    await userEvent.selectOptions(screen.getByLabelText("Cursor seat for p1@liatrio.com"), "premium")
    await waitFor(() => expect(screen.getByTestId("cursor-seat-summary")).toHaveTextContent("= $80.00"))
    const [url, init] = fetchMock.mock.calls.at(-1)!
    expect(url).toBe("/api/admin/org/cursor-seats/assign")
    expect(JSON.parse(init.body)).toEqual({ person_ids: ["p1"], seat_type: "premium" })
  })

  it("admin Seat assignments card loads people and assigns a seat type through the cursor-seats assign endpoint (#92)", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/admin/org")
        return reply({
          people: [
            { id: "p1", email: "p1@liatrio.com", display_name: "Pat", team_id: null, active: true },
            { id: "p2", email: "sam@liatrio.com", display_name: "Sam", team_id: null, active: true },
            { id: "p3", email: "gone@liatrio.com", display_name: "Gone", team_id: null, active: false },
          ],
        })
      if (init?.method === "POST") return reply(state({ current: { p1: "standard", p2: "free" } }))
      return reply(state())
    })
    render(<CursorSeatAssignmentsCard />)
    const list = await screen.findByTestId("cursor-seat-list")
    await waitFor(() => expect(screen.getByLabelText("Cursor seat for sam@liatrio.com")).toHaveValue("none"))
    expect(list).toHaveTextContent("Pat")
    // Inactive people without a seat are left out of the list.
    expect(screen.queryByLabelText("Cursor seat for gone@liatrio.com")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Cursor seat for p1@liatrio.com")).toHaveValue("standard")

    await userEvent.selectOptions(screen.getByLabelText("Cursor seat for sam@liatrio.com"), "free")
    await waitFor(() => expect(screen.getByLabelText("Cursor seat for sam@liatrio.com")).toHaveValue("free"))
    const [url, init] = fetchMock.mock.calls.at(-1)!
    expect(url).toBe("/api/admin/org/cursor-seats/assign")
    expect(JSON.parse(init.body)).toEqual({ person_ids: ["p2"], seat_type: "free" })
    // Rates, roster import and the cycle summary stay on the same card.
    expect(screen.getByLabelText("Standard monthly rate")).toBeInTheDocument()
    expect(screen.getByLabelText("Roster CSV file")).toBeInTheDocument()
    expect(screen.getByTestId("cursor-seat-summary")).toBeInTheDocument()
  })

  it("shows a loading state, not 'No people match', while the people directory is in flight (#92)", async () => {
    let releasePeople: (v: unknown) => void = () => {}
    fetchMock.mockImplementation((url: string) =>
      url === "/api/admin/org" ? new Promise((r) => (releasePeople = r)) : reply(state())
    )
    render(<CursorSeatAssignmentsCard />)
    expect(await screen.findByTestId("cursor-seat-people-loading")).toBeInTheDocument()
    expect(screen.queryByText("No people match.")).not.toBeInTheDocument()
    releasePeople({ ok: true, status: 200, json: async () => ({ people: [{ id: "p1", email: "p1@liatrio.com", display_name: "Pat", active: true }] }) })
    expect(await screen.findByLabelText("Cursor seat for p1@liatrio.com")).toHaveValue("standard")
  })

  it("keeps a failed people load visible after the seat state loads (#92)", async () => {
    let releaseSeats: (v: unknown) => void = () => {}
    fetchMock.mockImplementation((url: string) =>
      url === "/api/admin/org" ? reply({ error: "people boom" }, 500) : new Promise((r) => (releaseSeats = r))
    )
    render(<CursorSeatAssignmentsCard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    // Seats resolve after the people failure; their success must not clear it.
    releaseSeats({ ok: true, status: 200, json: async () => state() })
    expect(await screen.findByRole("alert")).toHaveTextContent("people boom")
    expect(screen.getByTestId("cursor-seat-summary")).toBeInTheDocument()
  })
})
