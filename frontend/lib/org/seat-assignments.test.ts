/**
 * Seat assignment planning (issue #26): split sums, re-assignment, un-split
 * entries, and that split rows resolve to people and teams the same way
 * cost_records_daily_attributed does (scripts/migration-tests/assertions_016.sql
 * runs the same cases in SQL).
 */

import { buildOrgIndex, resolveAttribution } from "./attribution"
import { computeBreakdown } from "./breakdown"
import { canAttribute, coverageFor } from "./coverage"
import { rollup, toAttributedDailyRows, type CostRecordLike } from "./rollup"
import {
  groupSeatEntries,
  isSeatEntry,
  isSeatProvider,
  planSeatSplit,
  SeatPlanError,
  sumMicros,
  toMicros,
  type NewSeatRow,
  type SeatEntryRow,
} from "./seat-assignments"
import { D, PE, T, orgData } from "./test-fixtures"
import { CLAUDE_MAX, prodSeatRows, PROD_TOTAL } from "./seat-fixtures"

const ids = () => {
  let n = 0
  return () => `sg-${++n}`
}

/** Apply a plan the way replace_seat_group() does: drop the old ids, insert the rows. */
function applyPlan(rows: SeatEntryRow[], replaced: string[], next: NewSeatRow[]): SeatEntryRow[] {
  let n = 0
  return [
    ...rows.filter((r) => !replaced.includes(r.id)),
    ...next.map((r) => ({ ...r, id: `new-${replaced[0]}-${++n}` })),
  ]
}

const toRecords = (rows: SeatEntryRow[]): CostRecordLike[] =>
  rows.map((r) => ({
    provider_id: r.provider_id,
    timestamp: r.timestamp,
    model_name: r.model_name,
    cost_usd: r.cost_usd,
    request_count: r.request_count,
    metadata: r.metadata,
  }))

const april = (rows: SeatEntryRow[]) => groupSeatEntries(rows).find((g) => g.month === "2026-04")!

describe("groupSeatEntries", () => {
  it("reads production-shaped rows as five plain months totalling $15,600", () => {
    const groups = groupSeatEntries(prodSeatRows())
    expect(groups.map((g) => g.month)).toEqual(["2026-08", "2026-06", "2026-05", "2026-04", "2026-03"])
    expect(groups.reduce((s, g) => s + g.total_usd, 0)).toBe(PROD_TOTAL)
    const g = april(prodSeatRows())
    expect(g).toMatchObject({
      seat_group_id: null,
      total_usd: 2800,
      total_seats: 14,
      price_per_seat: 200,
      assignments: [],
      remainder: { seats: 14, cost_usd: 2800 },
      timestamp: "2026-04-01T12:00:00.000Z",
      model_name: "seats",
      notes: "Ramp cards",
    })
  })

  it("ignores rows that are not manual seat entries", () => {
    const rows = prodSeatRows()
    const api = { ...rows[0], id: "api", collection_method: "api_automated" }
    const plain = { ...rows[0], id: "plain", metadata: { entry_type: "monthly_manual", month: "2026-03" } }
    expect(isSeatEntry(api)).toBe(false)
    expect(isSeatEntry(plain)).toBe(false)
    expect(groupSeatEntries([...rows, api, plain]).reduce((s, g) => s + g.total_usd, 0)).toBe(PROD_TOTAL)
  })
})

describe("planSeatSplit", () => {
  it("splits a month into N people plus a remainder that sums to the original total", () => {
    const rows = prodSeatRows()
    const g = april(rows)
    const plan = planSeatSplit(
      g,
      [
        { person_email: "Alice@Liatrio.com", seats: 1 },
        { person_email: "bob@liatrio.com", seats: 2 },
        { person_email: "carol@liatrio.com", seats: 1, cost_usd: 150 },
      ],
      { newGroupId: ids(), baseMetadata: rows.find((r) => r.id === g.row_ids[0])!.metadata }
    )
    expect(plan.rows).toHaveLength(4)
    expect(plan.rows.map((r) => r.cost_usd)).toEqual([200, 400, 150, 2050])
    expect(sumMicros(plan.rows)).toBe(toMicros(2800))
    expect(plan.remainder).toEqual({ seats: 10, cost_usd: 2050 })
    for (const r of plan.rows) {
      expect(r).toMatchObject({
        provider_id: CLAUDE_MAX,
        timestamp: "2026-04-01T12:00:00.000Z",
        model_name: "seats",
        collection_method: "manual_entry",
      })
      expect(r.metadata).toMatchObject({
        entry_type: "monthly_seats",
        month: "2026-04",
        price_per_seat: 200,
        cost_basis: "seat_subscription",
        notes: "Ramp cards",
        seat_group_id: "sg-1",
        seat_group_total_usd: 2800,
        seat_group_total_seats: 14,
      })
      expect(r.request_count).toBe(r.metadata.seats)
    }
    expect(plan.rows[0].metadata.attribution).toEqual({ granularity: "person", person_email: "alice@liatrio.com" })
    expect(plan.rows[3].metadata).toMatchObject({ remainder: true, attribution: { granularity: "org" }, seats: 10 })
  })

  it("keeps the total exact when costs need rounding (+/- $0.01 per person, remainder absorbs it)", () => {
    const g = { ...april(prodSeatRows()), total_usd: 1000, total_seats: 3, price_per_seat: 333.333333 }
    const plan = planSeatSplit(g, [{ person_email: "alice@liatrio.com", seats: 1 }, { person_email: "bob@liatrio.com", seats: 1 }], {
      newGroupId: ids(),
    })
    expect(plan.rows.map((r) => r.cost_usd)).toEqual([333.33, 333.33, 333.34])
    expect(sumMicros(plan.rows)).toBe(toMicros(1000))
  })

  it("omits the remainder row when every seat and dollar is assigned", () => {
    const g = april(prodSeatRows())
    const plan = planSeatSplit(g, [{ person_email: "alice@liatrio.com", seats: 14 }], { newGroupId: ids() })
    expect(plan.rows).toHaveLength(1)
    expect(sumMicros(plan.rows)).toBe(toMicros(2800))
  })

  it("re-assigning replaces the set, keeps the seat_group_id and does not change the total", () => {
    let rows = prodSeatRows()
    const newId = ids()
    const g1 = april(rows)
    const p1 = planSeatSplit(g1, [{ person_email: "alice@liatrio.com", seats: 1 }, { person_email: "bob@liatrio.com", seats: 2 }], { newGroupId: newId })
    rows = applyPlan(rows, g1.row_ids, p1.rows)

    const g2 = april(rows)
    expect(g2.seat_group_id).toBe("sg-1")
    expect(g2.row_ids).toHaveLength(3)
    expect(g2.total_usd).toBe(2800)
    expect(g2.total_seats).toBe(14)
    expect(g2.assignments).toEqual([
      { person_email: "alice@liatrio.com", seats: 1, cost_usd: 200 },
      { person_email: "bob@liatrio.com", seats: 2, cost_usd: 400 },
    ])

    const p2 = planSeatSplit(g2, [{ person_email: "dave@liatrio.com", seats: 3 }], { newGroupId: newId })
    expect(p2.seat_group_id).toBe("sg-1")
    rows = applyPlan(rows, g2.row_ids, p2.rows)
    const g3 = april(rows)
    expect(g3.assignments).toEqual([{ person_email: "dave@liatrio.com", seats: 3, cost_usd: 600 }])
    expect(g3.remainder).toEqual({ seats: 11, cost_usd: 2200 })
    expect(rows.filter((r) => r.metadata?.month === "2026-04")).toHaveLength(2)
    expect(sumMicros(rows)).toBe(toMicros(PROD_TOTAL))
  })

  it("no assignments collapses a split month back to one plain entry", () => {
    let rows = prodSeatRows()
    const g1 = april(rows)
    rows = applyPlan(rows, g1.row_ids, planSeatSplit(g1, [{ person_email: "alice@liatrio.com", seats: 1 }], { newGroupId: ids() }).rows)
    const g2 = april(rows)
    const plan = planSeatSplit(g2, [], { newGroupId: ids(), baseMetadata: { ...rows.at(-1)!.metadata } })
    expect(plan.seat_group_id).toBeNull()
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]).toMatchObject({ cost_usd: 2800, request_count: 14 })
    expect(plan.rows[0].metadata).toEqual({
      entry_type: "monthly_seats",
      month: "2026-04",
      seats: 14,
      price_per_seat: 200,
      cost_basis: "seat_subscription",
      notes: "Ramp cards",
    })
  })

  it.each([
    ["more seats than the month has", [{ person_email: "alice@liatrio.com", seats: 15 }], /seats assigned/],
    ["more money than the month has", [{ person_email: "alice@liatrio.com", seats: 1, cost_usd: 2800.01 }], /Totals don't reconcile/],
    ["a duplicate person", [{ person_email: "alice@liatrio.com", seats: 1 }, { person_email: "ALICE@liatrio.com", seats: 1 }], /twice/],
    ["a bad email", [{ person_email: "not-an-email", seats: 1 }], /Invalid email/],
    ["zero seats", [{ person_email: "alice@liatrio.com", seats: 0 }], /whole number/],
    ["fractional seats", [{ person_email: "alice@liatrio.com", seats: 1.5 }], /whole number/],
    ["a negative cost", [{ person_email: "alice@liatrio.com", seats: 1, cost_usd: -1 }], />= 0/],
  ])("rejects %s", (_label, input, message) => {
    expect(() => planSeatSplit(april(prodSeatRows()), input, { newGroupId: ids() })).toThrow(SeatPlanError)
    expect(() => planSeatSplit(april(prodSeatRows()), input, { newGroupId: ids() })).toThrow(message)
  })
})

describe("isSeatProvider", () => {
  it("accepts billing seat or a seat_subscription cost basis only", () => {
    expect(isSeatProvider({ metadata: { billing: "seat", collection_method: "manual" } })).toBe(true)
    expect(isSeatProvider({ metadata: { cost_basis: "seat_subscription" } })).toBe(true)
    expect(isSeatProvider({ metadata: { billing: "manual", cost_basis: "manual" } })).toBe(false)
    expect(isSeatProvider({ metadata: { billing: "quota" } })).toBe(false)
    expect(isSeatProvider(null)).toBe(false)
  })
})

describe("attribution of split rows", () => {
  function splitApril() {
    let rows = prodSeatRows()
    const g = april(rows)
    const plan = planSeatSplit(
      g,
      [
        { person_email: "alice@liatrio.com", seats: 1 },
        { person_email: "bob@liatrio.com", seats: 2 },
        { person_email: "carol@liatrio.com", seats: 1, cost_usd: 150 },
      ],
      { newGroupId: ids() }
    )
    rows = applyPlan(rows, g.row_ids, plan.rows)
    return rows
  }

  it("resolves each assigned row to the person, their team and department", () => {
    const index = buildOrgIndex(orgData())
    const rows = splitApril().filter((r) => r.metadata?.seat_group_id)
    const resolved = rows.map((r) => resolveAttribution(r, index))
    expect(resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ person_id: PE.alice, team_id: T.platform, department_id: D.eng, granularity: "person" }),
        expect.objectContaining({ person_id: PE.bob, team_id: T.field, department_id: D.sales, granularity: "person" }),
        expect.objectContaining({ person_id: PE.carol, team_id: null, department_id: null, granularity: "person" }),
        expect.objectContaining({ person_id: null, team_id: null, department_id: null, granularity: "org" }),
      ])
    )
  })

  it("rolls up per person and team with un-split months in Unassigned, counted once", () => {
    const index = buildOrgIndex(orgData())
    const daily = toAttributedDailyRows(toRecords(splitApril()), index)
    const person = rollup(daily, "person", index)
    const cost = (key: string) => person.find((b) => b.key === key)?.total_cost_usd
    expect(cost(PE.alice)).toBe(200)
    expect(cost(PE.bob)).toBe(400)
    expect(cost(PE.carol)).toBe(150)
    // 2050 April remainder + 12,800 across the four un-split months.
    expect(cost("unassigned")).toBe(2050 + 12800)
    expect(person.reduce((s, b) => s + b.total_cost_usd, 0)).toBe(PROD_TOTAL)
    const team = rollup(daily, "team", index)
    expect(team.find((b) => b.key === T.platform)?.total_cost_usd).toBe(200)
    expect(team.find((b) => b.key === T.field)?.total_cost_usd).toBe(400)
    expect(team.reduce((s, b) => s + b.total_cost_usd, 0)).toBe(PROD_TOTAL)
  })

  it("leaves un-split entries exactly as they were", () => {
    const before = prodSeatRows().filter((r) => r.metadata?.month !== "2026-04")
    const after = splitApril().filter((r) => r.metadata?.month !== "2026-04")
    expect(after).toEqual(before)
  })

  it("shows Claude Ultra spend per person in the dashboard breakdown", () => {
    const org = orgData()
    const daily = toAttributedDailyRows(toRecords(splitApril()), buildOrgIndex(org))
    const data = computeBreakdown({
      rows: daily,
      org,
      providers: [{ id: CLAUDE_MAX, name: "claude-max", display_name: "Claude Ultra", metadata: { billing: "seat" } }],
      filters: {},
      params: { month: "2026-04" },
      now: new Date("2026-04-20T00:00:00Z"),
    })
    const alice = data.person.find((e) => e.id === PE.alice)!
    expect(alice.cost).toBe(200)
    expect(alice.byProvider["claude-max"]).toBe(200)
    expect(data.person.find((e) => e.unassigned)?.cost).toBe(2050)
    expect(data.person.reduce((s, e) => s + e.cost, 0)).toBe(2800)
    expect(data.team.find((e) => e.id === T.field)?.cost).toBe(400)
  })

  it("coverage says Claude Ultra can reach a person, under the claude-max slug", () => {
    expect(canAttribute("claude-max", "person")).toBe(true)
    expect(coverageFor("claude-max").note).toMatch(/Claude Ultra/)
  })
})
