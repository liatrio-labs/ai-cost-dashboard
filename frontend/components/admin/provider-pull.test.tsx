import "@testing-library/jest-dom"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PULL_PROVIDERS, ProviderPullCard, pullRequestBody, rangeProblem } from "./provider-pull"
import { formatSyncSummary } from "./gateway-key-sync"

const json = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, json: async () => body }) as unknown as Response

describe("pullRequestBody", () => {
  it("sends the range to range providers, including vercel-ai-gateway", () => {
    const o = { backfill: true, startDate: "2026-10-01", endDate: "2026-10-31" }
    expect(pullRequestBody("vercel-ai-gateway", o)).toEqual({ provider: "vercel-ai-gateway", start_date: "2026-10-01", end_date: "2026-10-31" })
    expect(pullRequestBody("openai", o)).toEqual({ provider: "openai", start_date: "2026-10-01", end_date: "2026-10-31" })
    // Cursor has no range support: it keeps the backfill toggle.
    expect(pullRequestBody("cursor", o)).toEqual({ provider: "cursor", backfill: true })
  })

  it("without a range, sends backfill", () => {
    expect(pullRequestBody("vercel-ai-gateway", { backfill: false, startDate: "", endDate: "" })).toEqual({
      provider: "vercel-ai-gateway",
      backfill: false,
    })
  })
})

describe("rangeProblem", () => {
  it("mirrors the server's basic rules", () => {
    expect(rangeProblem("", "")).toBeNull()
    expect(rangeProblem("2026-10-01", "")).toMatch(/both/)
    expect(rangeProblem("2026-10-05", "2026-10-01")).toMatch(/on or before/)
    expect(rangeProblem("2026-10-01", "2026-11-01")).toMatch(/32 days/)
    expect(rangeProblem("2026-10-01", "2026-10-31")).toBeNull()
  })
})

describe("ProviderPullCard", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it("lists Vercel AI Gateway", () => {
    expect(PULL_PROVIDERS.map((p) => p.id)).toContain("vercel-ai-gateway")
    render(<ProviderPullCard />)
    expect(screen.getByText("Vercel AI Gateway")).toBeInTheDocument()
  })

  it("pulls the gateway with the date range and shows stored rows and key sync counts", async () => {
    const calls: { url: string; body: unknown }[] = []
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return json({
        status: "success",
        records_stored: 12,
        range: { start_date: "2026-10-01", end_date: "2026-10-10", clamped: false },
        key_sync: { status: "success", created: 2, updated: 1, unchanged: 3, manual_kept: 1, keys_listed: 6 },
      })
    }) as unknown as typeof fetch

    render(<ProviderPullCard />)
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-01" } })
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-10" } })
    await userEvent.click(screen.getByRole("button", { name: "Pull Vercel AI Gateway" }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      url: "/api/admin/collect",
      body: { provider: "vercel-ai-gateway", start_date: "2026-10-01", end_date: "2026-10-10" },
    })
    const row = screen.getByTestId("pull-vercel-ai-gateway")
    expect(await within(row).findByText(/Stored 12 records for 2026-10-01 to 2026-10-10/)).toBeInTheDocument()
    expect(within(row).getByText(/Key sync: 6 keys: 2 created, 1 updated, 3 unchanged, 1 manual kept/)).toBeInTheDocument()
  })

  it("pulls the gateway with backfill when no range is set", async () => {
    const bodies: unknown[] = []
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return json({ status: "success", records_stored: 1 })
    }) as unknown as typeof fetch
    render(<ProviderPullCard />)
    await userEvent.click(screen.getByLabelText("Backfill last 90 days"))
    await userEvent.click(screen.getByRole("button", { name: "Pull Vercel AI Gateway" }))
    await waitFor(() => expect(bodies).toEqual([{ provider: "vercel-ai-gateway", backfill: true }]))
  })

  it("blocks pulls while the range is invalid", async () => {
    global.fetch = jest.fn() as unknown as typeof fetch
    render(<ProviderPullCard />)
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-01" } })
    expect(screen.getByRole("alert")).toHaveTextContent(/both/)
    expect(screen.getByRole("button", { name: "Pull Vercel AI Gateway" })).toBeDisabled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("Sync keys now shows counts, and shows a sync error clearly", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(json({ status: "success", created: 3, updated: 0, unchanged: 0, manual_kept: 0, keys_listed: 3 }))
      .mockResolvedValueOnce(json({ error: "Gateway key sync failed, nothing was changed: HTTP 403" }, 502)) as unknown as typeof fetch
    render(<ProviderPullCard />)
    const button = screen.getByRole("button", { name: "Sync keys now" })
    await userEvent.click(button)
    expect(await screen.findByRole("status")).toHaveTextContent("Synced 3 keys: 3 created, 0 updated, 0 unchanged, 0 manual kept")
    expect((global.fetch as jest.Mock).mock.calls[0]).toEqual(["/api/admin/org/keys/sync-gateway", { method: "POST" }])
    await userEvent.click(button)
    expect(await screen.findByRole("status")).toHaveTextContent("Gateway key sync failed, nothing was changed: HTTP 403")
  })
})

describe("formatSyncSummary", () => {
  it("adds people / projects / unresolved creators when non-zero", () => {
    expect(formatSyncSummary({ created: 1, updated: 0, unchanged: 0, manual_kept: 0, keys_listed: 1, people_created: 1, unresolved_creators: 2 })).toBe(
      "1 key: 1 created, 0 updated, 0 unchanged, 0 manual kept; 1 people created; 2 creators not matched to an email"
    )
  })
})
