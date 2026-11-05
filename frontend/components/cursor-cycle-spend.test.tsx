/**
 * Issue #76: the Cursor billing-cycle card shows cycle dates, per-member
 * limits and the team on-demand total, or a notice without migration 025.
 */

import { render, screen, within } from "@testing-library/react"
import { CursorCycleSpendCard, describeLimit } from "./cursor-cycle-spend"
import type { CursorCycleView } from "@/lib/cursor-spend"

const view: CursorCycleView = {
  available: true,
  current: {
    cycleStart: "2026-10-19T00:00:00.000Z",
    cycleEnd: "2026-11-19T00:00:00.000Z",
    cycleEndEstimated: true,
    teamSpendCents: 3684.5,
    teamOverallSpendCents: 14684.5,
    memberCount: 2,
    capturedAt: "2026-10-25T12:00:00.000Z",
    firstCapturedAt: "2026-10-19T01:05:00.000Z",
    members: [
      {
        email: "alice@example.com",
        name: "Alice",
        role: "member",
        spendCents: 2450,
        overallSpendCents: 9450,
        monthlyLimitDollars: 100,
        hardLimitOverrideDollars: null,
        effectivePerUserLimitDollars: 100,
      },
      {
        email: "bob@example.com",
        name: null,
        role: "owner",
        spendCents: 0,
        overallSpendCents: 4000,
        monthlyLimitDollars: 100,
        hardLimitOverrideDollars: 250,
        effectivePerUserLimitDollars: 250,
      },
    ],
  },
  previous: [
    {
      cycleStart: "2026-09-19T00:00:00.000Z",
      cycleEnd: "2026-10-19T00:00:00.000Z",
      cycleEndEstimated: false,
      teamSpendCents: 5000,
      teamOverallSpendCents: null,
      memberCount: 2,
      capturedAt: "2026-10-19T00:05:00.000Z",
      firstCapturedAt: null,
    },
  ],
}

describe("CursorCycleSpendCard", () => {
  it("shows the billing-cycle dates, team on-demand total, member limits and previous cycles", () => {
    render(<CursorCycleSpendCard view={view} />)
    expect(screen.getByTestId("cursor-cycle-dates").textContent).toBe("Oct 19, 2026 to Nov 19, 2026")
    expect(screen.getByText(/not the\s+calendar-month total/)).toBeTruthy()
    expect(screen.getByTestId("cursor-cycle-team-total").textContent).toBe("$36.85")
    const bob = screen.getAllByTestId("cursor-cycle-member").find((r) => r.getAttribute("data-email") === "bob@example.com")!
    expect(within(bob).getByText("$250.00")).toBeTruthy()
    expect(within(bob).getByText("override $250.00, team default $100.00")).toBeTruthy()
    const prev = screen.getAllByTestId("cursor-cycle-previous-row")
    expect(prev).toHaveLength(1)
    expect(prev[0].textContent).toContain("Sep 19, 2026 to Oct 19, 2026")
    expect(prev[0].textContent).toContain("$50.00")
  })

  it("shows the migration notice when 025 isn't applied", () => {
    render(<CursorCycleSpendCard view={{ available: false, notice: "needs migration 025" }} />)
    expect(screen.getByTestId("cursor-cycle-notice").textContent).toContain("needs migration 025")
  })

  it("describes a member with no limit", () => {
    expect(
      describeLimit({
        email: "c@example.com",
        name: null,
        role: null,
        spendCents: 1,
        overallSpendCents: null,
        monthlyLimitDollars: null,
        hardLimitOverrideDollars: null,
        effectivePerUserLimitDollars: null,
      })
    ).toEqual({ limit: "No limit", detail: null })
  })
})
