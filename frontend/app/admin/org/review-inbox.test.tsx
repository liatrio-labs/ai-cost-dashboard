/**
 * "Needs review" tab (issue #44): items by kind, Acknowledge with a note,
 * Assign through the existing assign flow, and the migration 018 notice.
 */

import "@testing-library/jest-dom"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { REVIEW_THRESHOLDS, type ReviewItem } from "@/lib/org/review-inbox"
import { ReviewTab } from "./review-inbox"
import type { Org } from "./shared"

const org = {
  departments: [],
  teams: [{ id: "team-a", name: "Alpha", department_id: null }],
  people: [],
  identities: [],
  apiKeys: [],
  projects: [],
  providers: [],
} as unknown as Org

const spike: ReviewItem = {
  id: "person_spike|p600|2026-10",
  kind: "person_spike",
  subject: "p600",
  period: "2026-10",
  amount: 600,
  projected: false,
  previousAmount: 285.71,
  ratio: 2.1,
  label: "Six Hundred",
  detail: "Anthropic",
  assign: { kind: "person", email: "p600@liatrio.com" },
  previous: null,
}
const projectedSpike: ReviewItem = { ...spike, id: "person_spike|pnow|2026-11", subject: "pnow", period: "2026-11", projected: true, label: "Now", assign: null }
const unassigned: ReviewItem = {
  ...spike,
  id: "unassigned_new|provider:x|2026-11-14",
  kind: "unassigned_new",
  subject: "provider:x",
  period: "2026-11-14",
  amount: 4,
  previousAmount: null,
  ratio: null,
  label: "OpenAI (no person, key or project)",
  detail: "OpenAI · first seen 2026-11-14",
  assign: null,
}

const inbox = (over: Record<string, unknown> = {}) => ({
  today: "2026-11-15",
  windowStart: "2026-09-01",
  months: { last: "2026-10", current: "2026-11" },
  thresholds: REVIEW_THRESHOLDS,
  items: [spike, projectedSpike, unassigned],
  hiddenCount: 2,
  decisions_available: true,
  notice: null,
  ...over,
})

type Call = { url: string; method: string; body: unknown }
let calls: Call[] = []
function mockFetch(getBody: () => unknown, post: { status: number; body: unknown } = { status: 201, body: {} }) {
  calls = []
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const res = method === "GET" ? { status: 200, body: getBody() } : post
    return { ok: res.status < 300, status: res.status, json: async () => res.body } as Response
  }) as jest.Mock
}

const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
})

test("lists items by kind with the projected label, ratio and hidden count", async () => {
  mockFetch(() => inbox())
  render(<ReviewTab org={org} mutate={jest.fn()} reloadKey={0} />)
  const spikes = await screen.findByRole("region", { name: "Person spikes" })
  expect(within(spikes).getAllByTestId("review-item")).toHaveLength(2)
  expect(within(spikes).getAllByText(/2.1x vs \$285.71 the month before/)).toHaveLength(2)
  expect(within(spikes).getByText("projected")).toBeInTheDocument()
  expect(within(screen.getByRole("region", { name: "Person-days" })).getByText("Nothing to review.")).toBeInTheDocument()
  expect(screen.getByText(/3 item\(s\) · 2 hidden by an earlier decision/)).toBeInTheDocument()
  // Nothing to assign for a provider-level Unassigned group.
  const un = within(screen.getByRole("region", { name: "Newly unassigned spend" })).getByTestId("review-item")
  expect(within(un).queryByRole("button", { name: "Assign" })).not.toBeInTheDocument()
})

test("Acknowledge posts the item with its note and reloads the inbox", async () => {
  let items = [spike]
  mockFetch(() => inbox({ items, hiddenCount: 0 }))
  render(<ReviewTab org={org} mutate={jest.fn()} reloadKey={0} />)
  const user = userEvent.setup()
  await user.type(await screen.findByRole("textbox", { name: "Note for Six Hundred" }), "offsite demo")
  items = []
  await user.click(screen.getByRole("button", { name: "Acknowledge" }))
  await waitFor(() => expect(screen.queryByText("Six Hundred")).not.toBeInTheDocument())
  expect(calls.find((c) => c.method === "POST")).toEqual({
    url: "/api/admin/org/review",
    method: "POST",
    body: { kind: "person_spike", subject: "p600", period: "2026-10", amount: 600, status: "acknowledged", note: "offsite demo" },
  })
})

test("Assign opens the existing assign flow, then records the decision with the note", async () => {
  mockFetch(() => inbox({ items: [spike] }))
  const mutate = jest.fn(async () => true)
  render(<ReviewTab org={org} mutate={mutate} reloadKey={0} />)
  const user = userEvent.setup()
  await user.type(await screen.findByRole("textbox", { name: "Note for Six Hundred" }), "moved")
  await user.click(screen.getByRole("button", { name: "Assign" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Team for Six Hundred" }), "team-a")
  const assignButtons = screen.getAllByRole("button", { name: "Assign" })
  await user.click(assignButtons[assignButtons.length - 1])
  expect(mutate).toHaveBeenCalledWith("/unassigned/assign", "POST", { kind: "person", email: "p600@liatrio.com", team_id: "team-a" }, "Assigned Six Hundred")
  await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true))
  expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ status: "assigned", note: "moved", subject: "p600" })
})

test("without migration 018: a clear notice, no Acknowledge, Assign still works", async () => {
  mockFetch(() => inbox({ decisions_available: false, notice: "Migration 018 not applied: the inbox is computed live, but Acknowledge and notes are unavailable." }))
  const mutate = jest.fn(async () => true)
  render(<ReviewTab org={org} mutate={mutate} reloadKey={0} />)
  expect(await screen.findByTestId("migration-018-notice")).toHaveTextContent(/Migration 018 not applied/)
  expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(screen.getAllByRole("button", { name: "Assign" })[0])
  await user.selectOptions(screen.getByRole("combobox", { name: "Team for Six Hundred" }), "team-a")
  const assignButtons = screen.getAllByRole("button", { name: "Assign" })
  await user.click(assignButtons[assignButtons.length - 1])
  expect(mutate).toHaveBeenCalled()
  // No decision is recorded without 018.
  expect(calls.some((c) => c.method === "POST")).toBe(false)
})

test("a load failure shows the error, not a crash", async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as Response) as jest.Mock
  render(<ReviewTab org={org} mutate={jest.fn()} reloadKey={0} />)
  expect(await screen.findByText("boom")).toBeInTheDocument()
})

test("network failures surface an error and never leave the tab spinning or the buttons disabled", async () => {
  global.fetch = jest.fn(async () => {
    throw new TypeError("Failed to fetch")
  }) as jest.Mock
  const { unmount } = render(<ReviewTab org={org} mutate={jest.fn()} reloadKey={0} />)
  expect(await screen.findByText("Network error: Failed to fetch")).toBeInTheDocument()
  unmount()

  // Loads fine, then Acknowledge and Assign hit network failures.
  let failPost = false
  global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET" && failPost) throw new TypeError("Failed to fetch")
    return { ok: true, status: 200, json: async () => inbox({ items: [spike] }) } as Response
  }) as jest.Mock
  const mutate = jest.fn(async () => {
    throw new TypeError("offline")
  })
  render(<ReviewTab org={org} mutate={mutate} reloadKey={0} />)
  const user = userEvent.setup()
  const ack = await screen.findByRole("button", { name: "Acknowledge" })
  failPost = true
  await user.click(ack)
  expect(await screen.findByText("Network error: Failed to fetch")).toBeInTheDocument()
  expect(ack).toBeEnabled()

  await user.click(screen.getByRole("button", { name: "Assign" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Team for Six Hundred" }), "team-a")
  const assignButtons = screen.getAllByRole("button", { name: "Assign" })
  await user.click(assignButtons[assignButtons.length - 1])
  expect(await screen.findByText("Assign failed: offline")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Acknowledge" })).toBeEnabled()
})
