/**
 * Issue #88 AC14: /admin is grouped into Data ingest / Tools and costs /
 * Access with a section nav, and the sync status strip (with its warnings)
 * stays on /admin, first in Data ingest.
 */
import "@testing-library/jest-dom"
import { render, screen, waitFor, within } from "@testing-library/react"
import { AdminClient } from "./AdminClient"
import type { ProviderFreshness } from "@/lib/sync-freshness"

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }) }))
jest.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: jest.fn() } }) }))
// Cards with their own data loading are stubbed; this test is about page layout.
function mockStub(name: string) {
  return function Stub() {
    return <div data-testid={`stub-${name}`} />
  }
}
jest.mock("@/components/monthly-entry-form", () => ({ MonthlyEntryForm: mockStub("monthly-entry") }))
jest.mock("@/components/admin/manage-tools", () => ({ ManageTools: mockStub("manage-tools") }))
jest.mock("@/components/admin/manage-entries", () => ({ ManageEntries: mockStub("manage-entries") }))
jest.mock("@/components/admin/seat-assignments", () => ({ SeatAssignmentsCard: mockStub("seat-assignments") }))
jest.mock("@/components/admin/cursor-seats", () => ({ CursorSeatAssignmentsCard: mockStub("cursor-seats") }))
jest.mock("@/components/admin/admins", () => ({ AdminsCard: mockStub("admins") }))
jest.mock("@/components/admin/invoice-overrides", () => ({ InvoiceOverridesCard: mockStub("invoice-overrides") }))
jest.mock("@/components/admin/forecast-settings", () => ({ ForecastSettingsCard: mockStub("forecast-settings") }))
jest.mock("@/components/admin/forecast-units", () => ({ ForecastUnitsCard: mockStub("forecast-units") }))
jest.mock("@/components/admin/provider-pull", () => ({ ProviderPullCard: mockStub("provider-pull") }))

const stale: ProviderFreshness = {
  id: "openai",
  slug: "openai",
  name: "OpenAI API",
  state: "stale",
  lastSyncedAt: "2026-11-03T15:56:00Z",
  schedule: "30 8 * * *",
  expectedRunAt: "2026-11-04T08:30:00Z",
  warning: true,
}

describe("Admin page sections (#88 AC14)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it("has section nav and groups, and keeps the sync warning strip on /admin first in Data ingest", async () => {
    global.fetch = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url === "/api/dashboard/freshness" ? { asOf: "2026-11-04T15:00:00Z", providers: [stale] } : []),
    })) as unknown as typeof fetch
    render(<AdminClient />)

    const nav = screen.getByRole("navigation", { name: "Admin sections" })
    expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Data ingest", "#data-ingest"],
      ["Tools and costs", "#tools-costs"],
      ["Access", "#access"],
    ])

    const ingest = screen.getByRole("region", { name: "Data ingest" })
    const sync = await waitFor(() => within(ingest).getByRole("region", { name: "Sync status" }))
    expect(within(sync).getByRole("alert")).toHaveTextContent("OpenAI API missed its")
    // The strip is the first thing in Data ingest, ahead of the pull card.
    const pull = within(ingest).getByTestId("stub-provider-pull")
    expect(sync.compareDocumentPosition(pull) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const tools = screen.getByRole("region", { name: "Tools and costs" })
    expect(within(tools).getByTestId("stub-manage-tools")).toBeInTheDocument()
    expect(within(tools).getByTestId("stub-seat-assignments")).toBeInTheDocument()
    // Issue #92: Cursor seat types are edited next to Claude Ultra seat assignments.
    const seatArea = tools.querySelector("#seat-assignments") as HTMLElement
    expect(within(seatArea).getByTestId("stub-seat-assignments")).toBeInTheDocument()
    expect(within(seatArea).getByTestId("stub-cursor-seats")).toBeInTheDocument()
    const access = screen.getByRole("region", { name: "Access" })
    expect(within(access).getByTestId("stub-admins")).toBeInTheDocument()
    expect(within(access).getByText("People cleanup")).toBeInTheDocument()
    // Sections are collapsible and open by default.
    for (const r of [ingest, tools, access]) expect(r.querySelector("details")).toHaveAttribute("open")
  })
})
