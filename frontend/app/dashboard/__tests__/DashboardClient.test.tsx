import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { DashboardClient } from "../DashboardClient"
import { buildDashboardData } from "@/lib/dashboard/aggregate"
import { buildBreakdown } from "@/lib/dashboard/breakdown"
import { attributedRows, emptyOrg, plainDailyRows, providerRows } from "@/lib/dashboard/test-fixtures"
import { orgData } from "@/lib/org/test-fixtures"

let mockParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => mockParams,
}))
beforeEach(() => {
  mockParams = new URLSearchParams()
})

const dashboard = buildDashboardData(plainDailyRows(), providerRows, { month: "2026-11" }, { ceiling: 1000, meta: {} })

function mockFetch(org: ReturnType<typeof orgData>, filters = {}) {
  const breakdown = buildBreakdown(attributedRows(org), org, providerRows, { month: "2026-11" }, filters)
  global.fetch = jest.fn(async (url: string) => {
    const body = String(url).startsWith("/api/dashboard/breakdown") ? breakdown : dashboard
    return { ok: true, status: 200, json: async () => body } as Response
  }) as unknown as typeof fetch
}

describe("DashboardClient", () => {
  it("looks as before when no org structure exists: no Org tab, no filters", async () => {
    mockFetch(emptyOrg())
    render(<DashboardClient />)
    expect(await screen.findByRole("tab", { name: /tools/i })).toBeInTheDocument()
    expect(screen.getAllByRole("tab")).toHaveLength(3)
    expect(screen.queryByTestId("org-filter-bar")).not.toBeInTheDocument()
    expect(screen.getAllByText("$347.00").length).toBeGreaterThan(0)
    expect(global.fetch).toHaveBeenCalledWith("/api/dashboard")
  })

  it("shows the Org tab and filter bar once an org structure exists", async () => {
    mockFetch(orgData())
    render(<DashboardClient />)
    expect(await screen.findByRole("tab", { name: /org/i })).toBeInTheDocument()
    expect(screen.getByTestId("org-filter-bar")).toBeInTheDocument()
  })

  it("keeps the filter bar when a filter matches no spend at all", async () => {
    mockParams = new URLSearchParams("month=2026-11&team=team-orphan&provider=prov-windsurf")
    const empty = buildDashboardData([], providerRows, { month: "2026-11" }, { ceiling: 1000, meta: {} })
    mockFetch(orgData(), { team: "team-orphan", provider: "prov-windsurf" })
    const breakdownFetch = global.fetch as jest.Mock
    global.fetch = jest.fn(async (url: string) =>
      String(url).startsWith("/api/dashboard/breakdown")
        ? breakdownFetch(url)
        : ({ ok: true, status: 200, json: async () => empty } as Response)
    ) as unknown as typeof fetch
    render(<DashboardClient />)
    expect(await screen.findByText("No spend in this period")).toBeInTheDocument()
    expect(screen.queryByText("No spend data yet")).not.toBeInTheDocument()
    expect(screen.getByTestId("org-filter-bar")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument()
  })
})
