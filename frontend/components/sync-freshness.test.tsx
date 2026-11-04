import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"
import { SyncFreshness, SyncFreshnessView } from "./sync-freshness"
import type { ProviderFreshness } from "@/lib/sync-freshness"

const f = (o: Partial<ProviderFreshness> & Pick<ProviderFreshness, "id" | "name" | "state">): ProviderFreshness => ({
  slug: o.id,
  lastSyncedAt: null,
  schedule: null,
  expectedRunAt: null,
  warning: ["stale", "never", "manual_missing"].includes(o.state),
  ...o,
})

const data = {
  asOf: "2026-11-04T15:00:00Z",
  providers: [
    f({ id: "anthropic", name: "Anthropic", state: "fresh", lastSyncedAt: "2026-11-04T08:55:00Z", schedule: "0 8 * * *" }),
    f({
      id: "openai",
      name: "OpenAI API",
      state: "stale",
      lastSyncedAt: "2026-11-03T15:56:00Z",
      schedule: "30 8 * * *",
      expectedRunAt: "2026-11-04T08:30:00Z",
    }),
    f({ id: "chatgpt", name: "ChatGPT Business", state: "manual_missing" }),
  ],
}

describe("SyncFreshnessView", () => {
  it("shows a badge per provider with Chicago times and lists warnings", () => {
    render(<SyncFreshnessView data={data} />)
    expect(screen.getByText(/Synced 6h ago · Nov 4, 2:55 AM CST/)).toBeInTheDocument()
    expect(screen.getByText(/Missed sync · Nov 3, 9:56 AM CST/)).toBeInTheDocument()
    expect(screen.getByText("No Nov entry")).toBeInTheDocument()
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("OpenAI API missed its Nov 4, 2:30 AM CST sync.")
    expect(alert).toHaveTextContent("ChatGPT Business has no November 2026 entry yet.")
  })

  it("shows no warning block when everything is fresh", () => {
    render(<SyncFreshnessView data={{ ...data, providers: [data.providers[0]] }} />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("SyncFreshness", () => {
  it("renders nothing when the request fails", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as unknown as typeof fetch
    const { container } = render(<SyncFreshness />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/dashboard/freshness"))
    expect(container).toBeEmptyDOMElement()
  })
})
