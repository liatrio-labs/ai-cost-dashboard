/**
 * Issue #92: Cursor seat types are edited under Seat assignments on /admin,
 * not on /admin/org People rows. Rows may show the current type read-only.
 */

import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"
import { PeopleTab } from "./OrgAdminClient"
import type { Org } from "./shared"

const org = {
  departments: [],
  teams: [],
  people: [
    { id: "p1", email: "p1@liatrio.com", display_name: "Pat", team_id: null, active: true },
    { id: "p2", email: "p2@liatrio.com", display_name: "Sam", team_id: null, active: true },
  ],
  identities: [],
  apiKeys: [],
  projects: [],
  providers: [],
} as unknown as Org

const CYCLE = { key: "2026-11", start: "2026-11-20", end: "2026-12-20", label: "Nov 20 – Dec 20, 2026" }
const seatState = {
  available: true,
  notice: null,
  currentMonth: "2026-11",
  cycle: CYCLE,
  cycleInProgress: CYCLE,
  rates: { standard: 40, premium: 80, free: 0 },
  rateHistory: [],
  current: { p1: "premium" },
  assignmentCount: 1,
  summary: { month: "2026-11", cycle: CYCLE, counts: { standard: 0, premium: 1, free: 0, none: 1 }, rates: { standard: 40, premium: 80, free: 0 }, total_usd: 80 },
  recurringConflict: false,
}

const fetchMock = jest.fn()
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url === "/api/admin/org/cursor-seats" ? seatState : { groups: [] }),
  }))
  global.fetch = fetchMock as unknown as typeof fetch
})

describe("People tab (#92)", () => {
  it("people rows do not render the Cursor seat-type editor and only show the type read-only", async () => {
    render(<PeopleTab org={org} mutate={jest.fn(async () => true)} onMerged={jest.fn(async () => {})} reloadKey={0} />)

    await waitFor(() => expect(screen.getByTestId("cursor-seat-label")).toHaveTextContent("Cursor: Premium"))
    expect(screen.queryByLabelText(/^Cursor seat for/)).not.toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /^Cursor:/ })).not.toBeInTheDocument()
    // Rates, roster import and the cycle summary moved off this page too.
    expect(screen.queryByLabelText("Standard monthly rate")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Roster CSV file")).not.toBeInTheDocument()
    expect(screen.getByTestId("cursor-seats-moved")).toHaveTextContent("Admin > Seat assignments")
    expect(screen.getByRole("link", { name: "Admin > Seat assignments" })).toHaveAttribute("href", "/admin#seat-assignments")
    // Never writes seat data from the people page.
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/admin/org/cursor-seats/"))).toBe(false)
  })
})
