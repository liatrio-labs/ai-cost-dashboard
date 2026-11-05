/**
 * Invoice actuals card on /admin (issue #75). fetch is mocked; no network.
 */

import "@testing-library/jest-dom"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InvoiceOverridesCard, invoiceMonthChoices } from "./invoice-overrides"

const PROVIDERS = [{ id: "prov-cursor", name: "Cursor" }]
const OVERRIDE = {
  provider_id: "prov-cursor",
  month: "2026-09",
  api_usd: 42886.81,
  manual_usd: 0,
  recurring_usd: 0,
  without_override_usd: 42886.81,
  billed_amount_usd: 1000,
  credits_usd: null,
  notes: "trial reconciliation",
  invoice_ids: ["INV-1"],
  entered_by: "admin@liatrio.com",
  entered_at: "2026-11-04T00:00:00Z",
  delta_usd: -41886.81,
}

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body } = handler(url, init)
    return { ok: status < 400, status, json: async () => body } as Response
  })
  global.fetch = fn as unknown as typeof fetch
  return fn
}

afterEach(() => {
  jest.restoreAllMocks()
})

it("offers complete months only, newest first", () => {
  const months = invoiceMonthChoices("2026-11")
  expect(months[0]).toBe("2026-10")
  expect(months).not.toContain("2026-11")
})

it("shows the API value next to the invoiced amount, and clears after confirming", async () => {
  const state = { available: true, notice: null, currentMonth: "2026-11", overrides: [OVERRIDE] }
  const fetchFn = mockFetch((_url, init) => (init?.method === "DELETE" ? { body: { ...state, overrides: [] } } : { body: state }))
  render(<InvoiceOverridesCard providers={PROVIDERS} />)
  const table = await screen.findByTestId("invoice-overrides-table")
  const row = within(table).getByText("Cursor").closest("tr")!
  expect(within(row).getAllByText("$42,886.81")).toHaveLength(2)
  expect(within(row).getByText("$1,000.00")).toBeInTheDocument()
  expect(within(row).getByText("−$41,886.81")).toBeInTheDocument()
  expect(within(row).getByText("INV-1")).toBeInTheDocument()

  jest.spyOn(window, "confirm").mockReturnValue(true)
  await userEvent.click(within(row).getByRole("button", { name: /clear cursor 2026-09/i }))
  expect(fetchFn).toHaveBeenCalledWith("/api/admin/invoice-overrides?provider_id=prov-cursor&month=2026-09", { method: "DELETE" })
  expect(await screen.findByText(/No invoice actuals yet/)).toBeInTheDocument()
})

it("without migration 024 shows the notice and disables writes", async () => {
  mockFetch(() => ({ body: { available: false, notice: "Invoice actuals need database migration 024", currentMonth: "2026-11", overrides: [] } }))
  render(<InvoiceOverridesCard providers={PROVIDERS} />)
  expect(await screen.findByTestId("invoice-migration-notice")).toHaveTextContent(/migration 024/)
  expect(screen.getByRole("button", { name: /set invoice actual/i })).toBeDisabled()
  expect(screen.getByLabelText(/invoiced amount/i)).toBeDisabled()
})
