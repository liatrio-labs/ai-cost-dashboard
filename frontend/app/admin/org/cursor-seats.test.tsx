/**
 * Cursor seats on /admin/org (migration 026): the "migration 026 not
 * applied" notice with seat selects disabled, the month summary, and a
 * per-person seat change.
 */

import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CursorSeatsCard, SeatTypeSelect, useCursorSeats } from "./cursor-seats"
import type { Org } from "./shared"

const org = {
  departments: [],
  teams: [],
  people: [{ id: "p1", email: "p1@liatrio.com", display_name: "Pat", team_id: null }],
  identities: [],
  apiKeys: [],
  projects: [],
  providers: [],
} as unknown as Org

const state = (over: Record<string, unknown> = {}) => ({
  available: true,
  notice: null,
  currentMonth: "2026-11",
  rates: { standard: 40, premium: 80, free: 0 },
  rateHistory: [],
  current: { p1: "standard" },
  assignmentCount: 1,
  summary: { month: "2026-11", counts: { standard: 1, premium: 0, free: 0, none: 0 }, rates: { standard: 40, premium: 80, free: 0 }, total_usd: 40 },
  recurringConflict: false,
  ...over,
})

function Harness() {
  const seats = useCursorSeats(0)
  return (
    <>
      <CursorSeatsCard seats={seats} org={org} />
      <SeatTypeSelect seats={seats} personId="p1" label="p1@liatrio.com" />
    </>
  )
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
    expect(screen.getByLabelText("Cursor seat for p1@liatrio.com")).toBeDisabled()
  })

  it("shows the month's seat total and saves a person's seat type", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? reply(state({ current: { p1: "premium" }, summary: { month: "2026-11", counts: { standard: 0, premium: 1, free: 0, none: 0 }, rates: { standard: 40, premium: 80, free: 0 }, total_usd: 80 } }))
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
})
