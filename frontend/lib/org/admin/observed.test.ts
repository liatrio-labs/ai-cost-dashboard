import { buildOrgIndex } from "../attribution"
import { rollup, toAttributedDailyRows } from "../rollup"
import { orgData } from "../test-fixtures"
import { buildUnassignedQueue, currentMonth, listKeys, monthRange, type ObservedRecord } from "./observed"
import type { OrgSnapshot } from "./schemas"
import { MONTH, costRecords } from "./testing/seed"

const org: OrgSnapshot = {
  ...orgData(),
  projects: orgData().projects ?? [],
  identities: orgData().identities,
  providers: [],
}

const observed = (): ObservedRecord[] =>
  costRecords().map((r) => ({
    provider_id: r.provider_id,
    timestamp: r.timestamp,
    cost_usd: r.cost_usd,
    attribution: (r.metadata as { attribution?: unknown } | null)?.attribution ?? null,
  }))

const inMonth = (rs: ObservedRecord[], month: string) => {
  const { start, end } = monthRange(month)
  return rs.filter((r) => r.timestamp! >= start && r.timestamp! < end)
}

describe("buildUnassignedQueue", () => {
  it("reconciles with the team rollup's Unassigned bucket", () => {
    const records = inMonth(observed(), MONTH)
    const queue = buildUnassignedQueue(records, org, MONTH)

    const daily = toAttributedDailyRows(
      records.map((r) => ({ ...r, model_name: "m", metadata: { attribution: r.attribution } })) as never,
      buildOrgIndex(orgData())
    )
    const teamBuckets = rollup(daily, "team")
    const unassignedBucket = teamBuckets.find((b) => b.unassigned)!
    expect(queue.unassigned_total_usd).toBe(unassignedBucket.total_cost_usd)
    expect(queue.org_total_usd).toBeCloseTo(teamBuckets.reduce((s, b) => s + b.total_cost_usd, 0), 6)
    const subtotalSum = Object.values(queue.subtotals).reduce((s, n) => s + n, 0)
    expect(subtotalSum).toBeCloseTo(queue.unassigned_total_usd, 6)
  })

  it("is empty for a month with no spend", () => {
    expect(buildUnassignedQueue([], org, "2020-01")).toEqual({
      month: "2020-01",
      org_total_usd: 0,
      unassigned_total_usd: 0,
      subtotals: { person: 0, api_key: 0, project: 0, other: 0 },
      groups: [],
    })
  })
})

describe("helpers", () => {
  it("monthRange covers the UTC month, including December", () => {
    expect(monthRange("2026-11")).toEqual({ start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" })
    expect(monthRange("2026-12").end).toBe("2027-01-01T00:00:00.000Z")
    expect(currentMonth(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11")
  })

  it("listKeys keeps the latest observed name", () => {
    const rows = listKeys(
      [
        { provider_id: "p", timestamp: "2026-11-01T00:00:00Z", cost_usd: 1, attribution: { api_key_id: "k", api_key_name: "old", granularity: "api_key" } },
        { provider_id: "p", timestamp: "2026-11-03T00:00:00Z", cost_usd: "2.5", attribution: { api_key_id: "k", api_key_name: "new", granularity: "api_key" } },
      ],
      []
    )
    expect(rows).toEqual([
      expect.objectContaining({ external_key_id: "k", name: "new", total_cost_usd: 3.5, record_count: 2, last_seen: "2026-11-03T00:00:00Z" }),
    ])
  })
})
