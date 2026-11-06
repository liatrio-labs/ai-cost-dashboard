/**
 * Issue #86: the Cursor collector must append large usage-event batches
 * without spreading them into push() (which throws "Maximum call stack size
 * exceeded" around ~120k+ items in V8). No network: fetchWithRetry and sleep
 * are mocked, so every response here is synthetic.
 */

jest.mock("./http", () => {
  const actual = jest.requireActual("./http")
  return {
    ...actual,
    fetchWithRetry: jest.fn(),
    sleep: jest.fn(() => Promise.resolve()),
  }
})

import { appendAll, collector, CURSOR_ON_DEMAND_SINCE, fetchAllUsageEvents } from "./cursor"
import { DAY_MS, fetchWithRetry } from "./http"
import type { CollectorContext } from "./types"

const mockFetch = fetchWithRetry as jest.MockedFunction<typeof fetchWithRetry>

const LARGE = 200_000

function syntheticEvents(n: number, ts = Date.UTC(2026, 10, 3, 12)) {
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = {
      timestamp: String(ts),
      userEmail: `user${i % 50}@example.com`,
      model: "claude-4-sonnet",
      kind: "Usage-based",
      chargedCents: 1,
    }
  }
  return out
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function requestBody(callIndex: number): { startDate: number; endDate: number; page: number; pageSize: number } {
  const init = mockFetch.mock.calls[callIndex][1] as RequestInit
  return JSON.parse(String(init.body))
}

function usageCalls() {
  return mockFetch.mock.calls
    .map((c, i) => ({ url: String(c[0]), i }))
    .filter((c) => c.url.endsWith("/teams/filtered-usage-events"))
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe("cursor large-batch append (issue #86)", () => {
  it("appendAll appends 200,000 items without throwing 'Maximum call stack size exceeded'", () => {
    const target = [{ id: -1 }]
    const items = Array.from({ length: LARGE }, (_, id) => ({ id }))
    expect(() => appendAll(target, items)).not.toThrow()
    expect(target).toHaveLength(LARGE + 1)
    expect(target[0].id).toBe(-1)
    expect(target[1].id).toBe(0)
    expect(target[LARGE].id).toBe(LARGE - 1)
  })

  it("appendAll handles empty inputs and returns the target", () => {
    const target = [1, 2]
    expect(appendAll(target, [])).toBe(target)
    expect(appendAll([] as number[], [3])).toEqual([3])
  })

  it("fetchAllUsageEvents survives a single 200,000-event page and window without stack overflow", async () => {
    const big = syntheticEvents(LARGE)
    mockFetch.mockResolvedValue(
      jsonResponse({ usageEvents: big, pagination: { hasNextPage: false } })
    )
    const start = Date.parse(`${CURSOR_ON_DEMAND_SINCE}T00:00:00Z`)
    const events = await fetchAllUsageEvents("test-key", start, start + 6 * DAY_MS - 1)
    expect(events).toHaveLength(LARGE)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe("cursor pagination and windows (issue #86 regression guard)", () => {
  it("follows hasNextPage with pageSize 1000 and concatenates pages in order", async () => {
    const pages = [syntheticEvents(1000), syntheticEvents(1000), syntheticEvents(5)]
    pages.forEach((p, n) => p.forEach((e, i) => (e.model = `p${n}-${i}`)))
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ usageEvents: pages[0], pagination: { hasNextPage: true } }))
      .mockResolvedValueOnce(jsonResponse({ usageEvents: pages[1], pagination: { hasNextPage: true } }))
      .mockResolvedValueOnce(jsonResponse({ usageEvents: pages[2], pagination: { hasNextPage: false } }))

    const start = Date.parse("2026-11-01T00:00:00Z")
    const events = await fetchAllUsageEvents("test-key", start, start + DAY_MS - 1)

    expect(events).toHaveLength(2005)
    expect(events[0].model).toBe("p0-0")
    expect(events[1000].model).toBe("p1-0")
    expect(events[2004].model).toBe("p2-4")
    expect([0, 1, 2].map((i) => requestBody(i).page)).toEqual([1, 2, 3])
    expect([0, 1, 2].every((i) => requestBody(i).pageSize === 1000)).toBe(true)
  })

  it("stops on an empty page even if hasNextPage is true", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ usageEvents: syntheticEvents(3), pagination: { hasNextPage: true } }))
      .mockResolvedValueOnce(jsonResponse({ usageEvents: [], pagination: { hasNextPage: true } }))
    const start = Date.parse("2026-11-01T00:00:00Z")
    const events = await fetchAllUsageEvents("test-key", start, start + DAY_MS - 1)
    expect(events).toHaveLength(3)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("chunks ranges longer than 30 days into adjacent, non-overlapping windows", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ usageEvents: syntheticEvents(2), pagination: { hasNextPage: false } }))
    const start = Date.parse("2026-09-01T00:00:00Z")
    const end = start + 45 * DAY_MS - 1
    const events = await fetchAllUsageEvents("test-key", start, end)
    expect(events).toHaveLength(4)
    const [a, b] = [requestBody(0), requestBody(1)]
    expect(a.startDate).toBe(start)
    expect(a.endDate).toBe(start + 30 * DAY_MS - 1)
    expect(b.startDate).toBe(a.endDate + 1)
    expect(b.endDate).toBe(end)
  })
})

describe("cursor collect cutoff with large batches (issue #86)", () => {
  const NOW = Date.UTC(2026, 10, 6, 17, 27)
  const cutoffMs = Date.parse(`${CURSOR_ON_DEMAND_SINCE}T00:00:00Z`)

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] })
    mockFetch.mockImplementation(async (url) =>
      String(url).endsWith("/teams/spend")
        ? jsonResponse({ teamMemberSpend: [] })
        : jsonResponse({ usageEvents: syntheticEvents(LARGE), pagination: { hasNextPage: false } })
    )
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it.each([90, 6])("a %i-day backfill is clamped to the on-demand cutoff and handles 200k events", async (days) => {
    const ctx: CollectorContext = { userId: "u", providerId: "p", teamId: "t", apiKey: "test-key" }
    const records = await collector.collect(ctx, { backfill: true, backfillDays: days })

    const calls = usageCalls()
    expect(calls).toHaveLength(1)
    const body = requestBody(calls[0].i)
    expect(body.startDate).toBe(cutoffMs)
    expect(body.endDate).toBe(Date.UTC(2026, 10, 7) - 1)
    // 50 synthetic members x 1 model x 1 day.
    expect(records).toHaveLength(50)
    expect(records.every((r) => r.timestamp.slice(0, 10) >= CURSOR_ON_DEMAND_SINCE)).toBe(true)
  })
})
