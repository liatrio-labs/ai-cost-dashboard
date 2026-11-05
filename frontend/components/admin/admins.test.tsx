/**
 * Admins card on /admin (issue #71). fetch is mocked; no network.
 */

import "@testing-library/jest-dom"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AdminsCard } from "./admins"

const BASE = {
  me: "me@liatrio.com",
  env_admins: ["owner@liatrio.com"],
  env_domains: [],
  admins: [
    { email: "me@liatrio.com", added_by: "owner@liatrio.com", added_at: "2026-10-01T00:00:00Z" },
    { email: "pat@liatrio.com", added_by: "owner@liatrio.com", added_at: "2026-10-02T00:00:00Z" },
  ],
  migration_applied: true,
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

it("shows env admins locked and table admins with who added them; self-removal disabled", async () => {
  mockFetch(() => ({ body: BASE }))
  render(<AdminsCard />)
  const owner = (await screen.findByText("owner@liatrio.com")).closest("li")!
  expect(within(owner).getByText(/from environment/)).toBeInTheDocument()
  expect(within(owner).queryByRole("button")).toBeNull()
  const me = screen.getByText("me@liatrio.com").closest("li")!
  expect(within(me).getByText(/added by owner@liatrio.com/)).toBeInTheDocument()
  expect(within(me).getByRole("button", { name: /remove/i })).toBeDisabled()
  const pat = screen.getByText("pat@liatrio.com").closest("li")!
  expect(within(pat).getByRole("button", { name: /remove/i })).toBeEnabled()
})

it("removes only after confirming", async () => {
  const fetchFn = mockFetch((url, init) =>
    init?.method === "DELETE" ? { body: { ...BASE, admins: BASE.admins.slice(0, 1) } } : { body: BASE }
  )
  render(<AdminsCard />)
  const pat = (await screen.findByText("pat@liatrio.com")).closest("li")!
  await userEvent.click(within(pat).getByRole("button", { name: /remove/i }))
  expect(fetchFn).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole("button", { name: /yes, remove/i }))
  expect(fetchFn).toHaveBeenLastCalledWith("/api/admin/admins?email=pat%40liatrio.com&confirm=true", { method: "DELETE" })
  expect(await screen.findByText(/Removed pat@liatrio.com/)).toBeInTheDocument()
  expect(screen.queryByText("pat@liatrio.com")).toBeNull()
})

it("only enables Add for @liatrio.com addresses", async () => {
  mockFetch(() => ({ body: BASE }))
  render(<AdminsCard />)
  const input = await screen.findByLabelText(/add an admin/i)
  const button = screen.getByRole("button", { name: /add admin/i })
  await userEvent.type(input, "someone@gmail.com")
  expect(button).toBeDisabled()
  expect(screen.getByText(/Only @liatrio.com addresses/)).toBeInTheDocument()
  await userEvent.clear(input)
  await userEvent.type(input, "new.person@liatrio.com")
  expect(button).toBeEnabled()
})

it("shows a migration 023 notice and disables add/remove when the table is missing", async () => {
  mockFetch(() => ({
    body: {
      ...BASE,
      admins: [],
      migration_applied: false,
      notice: "Migration 023 not applied: adding or removing admins is unavailable.",
    },
  }))
  render(<AdminsCard />)
  expect(await screen.findByText(/Migration 023 not applied/)).toBeInTheDocument()
  expect(screen.getByLabelText(/add an admin/i)).toBeDisabled()
  expect(screen.getByRole("button", { name: /add admin/i })).toBeDisabled()
  expect(screen.getByText("owner@liatrio.com")).toBeInTheDocument()
})
