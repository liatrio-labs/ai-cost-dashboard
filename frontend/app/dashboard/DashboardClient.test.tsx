/**
 * Issue #84: the Cursor billing-cycle card has its own dates, so it shows for
 * a selected person even when the calendar period has no spend for them, and
 * it asks the cycle route with the org filters (not the period).
 */

import "@testing-library/jest-dom"
import { act, render, screen } from "@testing-library/react"

let search = ""
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(search),
}))
jest.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: jest.fn() } }) }))

import { DashboardClient } from "./DashboardClient"

const CYCLE = {
  available: true,
  scope: { kind: "filtered", matchedMembers: 1 },
  current: {
    cycleStart: "2026-10-19T00:00:00.000Z",
    cycleEnd: "2026-11-19T00:00:00.000Z",
    cycleEndEstimated: true,
    teamSpendCents: 273421,
    teamOverallSpendCents: null,
    memberCount: 7,
    capturedAt: "2026-11-01T17:05:00.000Z",
    firstCapturedAt: "2026-10-19T00:00:00.000Z",
    members: [
      {
        email: "dave@liatrio.com",
        name: "Dave",
        role: "member",
        spendCents: 4200,
        overallSpendCents: null,
        monthlyLimitDollars: null,
        hardLimitOverrideDollars: null,
        effectivePerUserLimitDollars: null,
      },
    ],
    selectionSpendCents: 4200,
  },
  previous: [],
}

const EMPTY_PERIOD = {
  months: ["2026-11"],
  tools: [],
  period: { mode: "month", start: "2026-11-01", end: "2026-11-30", selectedMonth: "2026-11" },
  selectedMonth: "2026-11",
  dataStart: "2026-10-01",
  dataEnd: "2026-11-01",
}

const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
})

it("shows a person's cycle on-demand when the period has no calendar spend for them (issue #84)", async () => {
  search = "month=2026-11&person=p-dave"
  const calls: string[] = []
  global.fetch = jest.fn(async (url: string) => {
    calls.push(url)
    const body = url.startsWith("/api/dashboard/cursor-cycle") ? CYCLE : url.startsWith("/api/dashboard/breakdown") ? null : EMPTY_PERIOD
    return { ok: true, status: 200, json: async () => body } as Response
  }) as unknown as typeof fetch

  await act(async () => {
    render(<DashboardClient />)
  })

  expect(screen.getByText("No spend matches these filters")).toBeInTheDocument()
  const card = screen.getByTestId("cursor-cycle")
  expect(card).toHaveAttribute("data-context", "person")
  expect(screen.getByTestId("cursor-cycle-selection-total")).toHaveTextContent("$42.00")
  // Filters only; the calendar period never scopes the cycle.
  expect(calls).toContain("/api/dashboard/cursor-cycle?person=p-dave")
})

it("a non-Cursor provider filter neither requests nor shows the Cursor cycle", async () => {
  search = "month=2026-11&provider=openai"
  const calls: string[] = []
  global.fetch = jest.fn(async (url: string) => {
    calls.push(url)
    return { ok: true, status: 200, json: async () => (url.startsWith("/api/dashboard/breakdown") ? null : EMPTY_PERIOD) } as Response
  }) as unknown as typeof fetch

  await act(async () => {
    render(<DashboardClient />)
  })

  expect(calls.some((c) => c.startsWith("/api/dashboard/cursor-cycle"))).toBe(false)
  expect(screen.queryByTestId("cursor-cycle")).toBeNull()
  expect(screen.queryByTestId("cursor-cycle-loading")).toBeNull()
})
