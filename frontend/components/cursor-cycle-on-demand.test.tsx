/**
 * Issue #84: the Cursor billing-cycle on-demand card in the Tools and person
 * views. Every load state is visible (loading, error, not applicable, no
 * match, stale), the figure comes from spendCents with the saved cycle dates
 * and snapshot time, and it is kept apart from the calendar-month Cursor
 * total (usage events + seats).
 */

import "@testing-library/jest-dom"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { CursorCycleOnDemand, CursorCycleSpendCard, SEPARATION_NOTE, useCursorCycle } from "./cursor-cycle-spend"
import { CursorProductSplit } from "./claude-ai-products"
import { OrgBreakdown } from "./org/org-breakdown"
import { computeBreakdown } from "@/lib/org/breakdown"
import { attributedRows, PROVIDERS } from "@/lib/org/dashboard-fixtures"
import { PE, orgData } from "@/lib/org/test-fixtures"
import type { ScopedCursorCycleView } from "@/lib/cursor-cycle-scope"

const OCT19 = "2026-10-19T00:00:00.000Z"
const NOV19 = "2026-11-19T00:00:00.000Z"
const CAPTURED = "2026-11-06T17:05:00.000Z"
const FRESH_NOW = new Date("2026-11-06T18:00:00Z")

const jacob = {
  email: "jacob.lecoq@liatrio.com",
  name: "Jacob Lecoq",
  role: "member",
  spendCents: 12345,
  overallSpendCents: 99999,
  monthlyLimitDollars: 500,
  hardLimitOverrideDollars: null,
  effectivePerUserLimitDollars: 500,
}

type Loaded = Extract<ScopedCursorCycleView, { available: true }>
function personView(overrides: Partial<NonNullable<Loaded["current"]>> = {}, scope: Loaded["scope"] = { kind: "filtered", matchedMembers: 1 }): ScopedCursorCycleView {
  return {
    available: true,
    scope,
    current: {
      cycleStart: OCT19,
      cycleEnd: NOV19,
      cycleEndEstimated: true,
      teamSpendCents: 273421,
      teamOverallSpendCents: 999999,
      memberCount: 7,
      capturedAt: CAPTURED,
      firstCapturedAt: OCT19,
      members: [jacob],
      selectionSpendCents: 12345,
      ...overrides,
    },
    previous: [],
  }
}

describe("CursorCycleOnDemand states (issue #84)", () => {
  it("shows a visible error with the message and a retry, instead of hiding the card", () => {
    const retry = jest.fn()
    render(<CursorCycleOnDemand load={{ status: "error", message: "permission denied for table people" }} onRetry={retry} context="tools" />)
    const card = screen.getByTestId("cursor-cycle-error")
    expect(card).toHaveAttribute("role", "alert")
    expect(screen.getByTestId("cursor-cycle-error-message")).toHaveTextContent("permission denied for table people")
    fireEvent.click(within(card).getByRole("button", { name: /retry/i }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("shows a loading card while the snapshot loads", () => {
    render(<CursorCycleOnDemand load={{ status: "loading" }} />)
    expect(screen.getByTestId("cursor-cycle-loading")).toHaveAttribute("aria-busy", "true")
  })

  it("shows the migration-unavailable notice", () => {
    render(<CursorCycleOnDemand load={{ status: "loaded", view: { available: false, notice: "needs migration 025" } }} />)
    expect(screen.getByTestId("cursor-cycle-notice")).toHaveTextContent("needs migration 025")
  })

  it("shows why a filter can't apply instead of $0", () => {
    render(
      <CursorCycleSpendCard
        view={{ available: true, scope: { kind: "not_applicable", reason: "not per API key" }, current: null, previous: [] }}
      />
    )
    expect(screen.getByTestId("cursor-cycle-not-applicable")).toHaveTextContent("not per API key")
    expect(screen.queryByText("$0.00")).toBeNull()
  })
})

describe("person drill-down cycle card (issue #84)", () => {
  it("shows the person's spendCents total with the saved cycle dates and last snapshot time", () => {
    render(<CursorCycleSpendCard view={personView()} context="person" now={FRESH_NOW} />)
    expect(screen.getByTestId("cursor-cycle-title")).toHaveTextContent("Cursor on-demand, Oct 19 to Nov 19 billing cycle")
    expect(screen.getByTestId("cursor-cycle-dates")).toHaveTextContent("Oct 19, 2026 to Nov 19, 2026")
    expect(screen.getByTestId("cursor-cycle-captured")).toHaveTextContent("Last snapshot Nov 6, 5:05 PM UTC.")
    expect(screen.getByTestId("cursor-cycle-selection-total")).toHaveTextContent("$123.45")
    expect(screen.getByText("Jacob Lecoq on-demand this cycle")).toBeInTheDocument()
    // Team total shown for context only; overallSpendCents is not the headline.
    expect(screen.getByTestId("cursor-cycle-team-total")).toHaveTextContent("$2,734.21")
    expect(screen.queryByTestId("cursor-cycle-team-overall")).toBeNull()
    expect(screen.queryByTestId("cursor-cycle-stale")).toBeNull()
  })

  it("says the figure is a separate measure, never added to calendar events or seats", () => {
    render(<CursorCycleSpendCard view={personView()} context="person" now={FRESH_NOW} />)
    expect(screen.getByTestId("cursor-cycle-separation")).toHaveTextContent(SEPARATION_NOTE)
    expect(SEPARATION_NOTE).toMatch(/never added/)
    expect(SEPARATION_NOTE).toMatch(/seat subscription fees \(20th-to-20th seat cycle\)/)
  })

  it("flags a stale snapshot and a reset cycle", () => {
    const { unmount } = render(<CursorCycleSpendCard view={personView()} now={new Date("2026-11-07T06:00:00Z")} />)
    expect(screen.getByTestId("cursor-cycle-stale")).toHaveAttribute("data-reason", "old_snapshot")
    unmount()
    render(<CursorCycleSpendCard view={personView()} now={new Date("2026-11-19T01:00:00Z")} />)
    expect(screen.getByTestId("cursor-cycle-stale")).toHaveAttribute("data-reason", "cycle_ended")
  })

  it("says so when no Cursor member matches the person, rather than showing $0", () => {
    render(
      <CursorCycleSpendCard
        view={personView({ members: [], selectionSpendCents: null }, { kind: "filtered", matchedMembers: 0 })}
        now={FRESH_NOW}
      />
    )
    expect(screen.getByTestId("cursor-cycle-no-match")).toBeInTheDocument()
    expect(screen.queryByTestId("cursor-cycle-selection-total")).toBeNull()
  })

  it("renders in the Org person view only (level detail)", () => {
    const org = orgData()
    const build = (filters: Record<string, string>) =>
      computeBreakdown({ rows: attributedRows(org), org, providers: PROVIDERS, filters, params: { month: "2026-11" }, now: new Date("2026-11-15T00:00:00Z") })
    const slot = <div data-testid="person-cycle-slot" />
    const { unmount } = render(<OrgBreakdown data={build({ person: PE.dave })} onFiltersChange={() => {}} personCursorCycle={slot} />)
    expect(screen.getByTestId("person-cycle-slot")).toBeInTheDocument()
    unmount()
    render(<OrgBreakdown data={build({})} onFiltersChange={() => {}} personCursorCycle={slot} />)
    expect(screen.queryByTestId("person-cycle-slot")).toBeNull()
  })
})

describe("Cursor tool cycle card via useCursorCycle (issue #84)", () => {
  function Harness({ qs }: { qs: string }) {
    const { load, retry } = useCursorCycle(qs)
    return <CursorCycleOnDemand load={load} onRetry={retry} context="tools" now={FRESH_NOW} />
  }
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })
  const respond = (status: number, body: unknown) =>
    jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body } as Response)

  it("requests the cycle with the filters and shows the team cycle for the Cursor tool", async () => {
    const team = personView({}, { kind: "team" })
    global.fetch = respond(200, team)
    await act(async () => {
      render(<Harness qs="provider=cursor" />)
    })
    expect(global.fetch).toHaveBeenCalledWith("/api/dashboard/cursor-cycle?provider=cursor")
    const card = screen.getByTestId("cursor-cycle")
    expect(card).toHaveAttribute("data-context", "tools")
    expect(screen.getByTestId("cursor-cycle-team-total")).toHaveTextContent("$2,734.21")
  })

  it("a failed request shows the server's error, and retry refetches", async () => {
    global.fetch = respond(500, { error: "relation cursor_member_cycle_spend is broken" })
    await act(async () => {
      render(<Harness qs={`person=${PE.dave}`} />)
    })
    expect(screen.getByTestId("cursor-cycle-error-message")).toHaveTextContent("relation cursor_member_cycle_spend is broken")
    global.fetch = respond(200, personView())
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    })
    expect(screen.getByTestId("cursor-cycle-selection-total")).toHaveTextContent("$123.45")
  })
})

describe("calendar-month Cursor labels stay separate from the cycle (issue #84)", () => {
  it("the by-product card names events and seats and says it isn't the billing-cycle figure", () => {
    render(
      <CursorProductSplit
        products={[
          { product: "agent_chat", label: "Agent/Chat", cost: 30 },
          { product: "seats", label: "Seats", cost: 80 },
        ]}
        total={110}
      />
    )
    const card = screen.getByTestId("cursor-products")
    expect(card).toHaveTextContent(/from usage events/)
    expect(card).toHaveTextContent(/seat subscription fees/)
    expect(card).toHaveTextContent(/not the billing-cycle on-demand figure/)
    expect(card).toHaveTextContent("$110.00")
  })
})
