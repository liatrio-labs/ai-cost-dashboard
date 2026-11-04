/**
 * "Budgets" tab (issue #49): the "migration 020 not applied" state, the
 * projected-over-budget badge, alert settings by env var name, and saving.
 */

import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ALERT_ENV } from "@/lib/budget-alerts"
import { BudgetsTab } from "./budgets-tab"
import type { Org } from "./shared"

const org = {
  departments: [],
  teams: [{ id: "t1", name: "Platform", department_id: null }],
  people: [{ id: "p1", email: "p1@liatrio.com", display_name: "Pat", team_id: "t1" }],
  identities: [],
  apiKeys: [],
  projects: [],
  providers: [],
} as unknown as Org

const status = (id: string, label: string, state: string, projected: number) => ({
  budget: { id, scope: "team", subject_id: id, monthly_usd: 2000, note: null },
  subject: `team:${id}`,
  label,
  subjectExists: true,
  month: "2026-11",
  budgetUsd: 2000,
  actual: 1400,
  projected,
  ratio: projected / 2000,
  state,
  projectedOver: state !== "ok",
})

const response = (over: Record<string, unknown> = {}) => ({
  available: true,
  notice: null,
  month: "2026-11",
  statuses: [status("t1", "Platform", "projected_over", 3000), status("t2", "Quiet", "ok", 1500)],
  alerts: { mode: "dry_run", channels: { slack: false, email: false }, env: ALERT_ENV },
  ...over,
})

type Call = { url: string; method: string; body: unknown }
let calls: Call[] = []
function mockFetch(getBody: () => unknown, post: { status: number; body: unknown } = { status: 201, body: {} }) {
  calls = []
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const r = method === "GET" ? { status: 200, body: getBody() } : post
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response
  }) as unknown as typeof fetch
}

test("without migration 020: a clear notice and no form", async () => {
  mockFetch(() => ({ ...response(), available: false, statuses: [], notice: "Migration 020 not applied: budgets ... unavailable" }))
  render(<BudgetsTab org={org} reloadKey={0} />)
  expect(await screen.findByTestId("migration-020-notice")).toHaveTextContent(/migration 020 not applied/i)
  expect(screen.queryByRole("button", { name: /save budget/i })).not.toBeInTheDocument()
})

test("shows the projected-over-budget badge and alert settings by env var name", async () => {
  mockFetch(() => response())
  render(<BudgetsTab org={org} reloadKey={0} />)
  const rows = await screen.findAllByTestId("budget-row")
  expect(rows).toHaveLength(2)
  expect(rows[0]).toHaveTextContent("Platform")
  expect(rows[0]).toHaveTextContent("Projected over budget")
  expect(rows[0]).toHaveTextContent("150%")
  expect(rows[1]).toHaveTextContent("On track")
  const settings = screen.getByTestId("alert-settings")
  expect(settings).toHaveTextContent(/dry-run/)
  expect(settings).toHaveTextContent(ALERT_ENV.slackWebhook)
})

test("saving posts the budget and reloads", async () => {
  mockFetch(() => response())
  render(<BudgetsTab org={org} reloadKey={0} />)
  await screen.findAllByTestId("budget-row")
  await userEvent.selectOptions(screen.getByLabelText("Budget subject"), "t1")
  await userEvent.type(screen.getByLabelText("Monthly budget (USD)"), "2500")
  await userEvent.click(screen.getByRole("button", { name: /save budget/i }))
  await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true))
  expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/admin/org/budgets", body: { scope: "team", subject_id: "t1", monthly_usd: 2500, note: null } })
  expect(await screen.findByText("Budget saved.")).toBeInTheDocument()
  await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2))
})
