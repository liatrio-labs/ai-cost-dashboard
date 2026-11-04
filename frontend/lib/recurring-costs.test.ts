/**
 * Recurring monthly costs (issue #59): month expansion, change-from-month,
 * single-month override by a manual entry (no double counting), sync
 * freshness warning suppression, seat attribution (migration 016 splits) and
 * the projection treatment. Pure; no I/O.
 */

import {
  addMonths,
  attributeRecurringRows,
  coveredProviderIds,
  expandRecurringCosts,
  isMissingRelation,
  manualMonthKeys,
  parseRecurringInput,
  RecurringInputError,
  segmentFor,
  segmentMonths,
  type ManualCostRow,
  type RecurringCost,
  type RecurringMonthRow,
} from "@/lib/recurring-costs"
import { computeFreshness, type FreshnessProvider } from "@/lib/sync-freshness"
import { monthRange, projectPeriod, projectionContext, RECURRING_MODEL, SEAT_MODEL } from "@/lib/projection"
import { buildOrgIndex, resolveAttribution } from "@/lib/org/attribution"
import { orgData, PE, T, D } from "@/lib/org/test-fixtures"
import { applyFilters } from "@/lib/dashboard-filters"

const LOVABLE = "prov-lovable"
const ULTRA = "prov-claude-max"
const GPT = "prov-chatgpt"

let seq = 0
function seg(provider: string, start: string, end: string | null, amount: number, seats?: number, price?: number): RecurringCost {
  seq += 1
  return {
    id: `rc-${seq}`,
    provider_id: provider,
    start_month: `${start}-01`,
    end_month: end ? `${end}-01` : null,
    // PostgREST returns NUMERIC as strings
    monthly_cost_usd: amount.toFixed(2),
    seats: seats ?? null,
    price_per_seat: price === undefined ? null : price.toFixed(2),
  }
}

function manual(provider: string, month: string, cost: number, extra: Partial<ManualCostRow> = {}, meta: Record<string, unknown> = {}): ManualCostRow {
  seq += 1
  return {
    id: `cr-${seq}`,
    user_id: "u1",
    provider_id: provider,
    timestamp: `${month}-01T12:00:00Z`,
    model_name: "manual",
    cost_usd: cost,
    request_count: 1,
    collection_method: "manual_entry",
    metadata: { entry_type: "monthly_manual", month, ...meta },
    ...extra,
  }
}

/** A migration 016 seat split for a month: one row per person + org remainder. */
function seatSplit(provider: string, month: string, price: number, total: number, people: [string, number][]): ManualCostRow[] {
  const group = `sg-${month}`
  const assigned = people.reduce((s, [, n]) => s + n, 0)
  const base = { entry_type: "monthly_seats", month, price_per_seat: price, seat_group_id: group }
  const rows = people.map(([email, n]) =>
    manual(provider, month, n * price, { model_name: "seats", request_count: n }, { ...base, seats: n, attribution: { granularity: "person", person_email: email } })
  )
  rows.push(
    manual(provider, month, (total - assigned) * price, { model_name: "seats", request_count: total - assigned }, {
      ...base,
      seats: total - assigned,
      remainder: true,
      attribution: { granularity: "org" },
    })
  )
  return rows
}

const byMonth = (rows: RecurringMonthRow[]) => {
  const out: Record<string, number> = {}
  for (const r of rows) out[r.month] = Math.round(((out[r.month] ?? 0) + r.total_cost_usd) * 100) / 100
  return out
}

describe("month expansion", () => {
  test("start through end, inclusive", () => {
    expect(segmentMonths(seg(LOVABLE, "2026-06", "2026-08", 100), "2026-11")).toEqual(["2026-06", "2026-07", "2026-08"])
  })
  test("open-ended runs through the current month, never into the future", () => {
    expect(segmentMonths(seg(LOVABLE, "2026-09", null, 100), "2026-11")).toEqual(["2026-09", "2026-10", "2026-11"])
  })
  test("an end month in the future is capped at the current month", () => {
    expect(segmentMonths(seg(LOVABLE, "2026-10", "2027-03", 100), "2026-11")).toEqual(["2026-10", "2026-11"])
  })
  test("a segment starting after the current month has no months yet", () => {
    expect(segmentMonths(seg(LOVABLE, "2027-01", null, 100), "2026-11")).toEqual([])
  })
  test("crosses year boundaries", () => {
    expect(segmentMonths(seg(LOVABLE, "2025-11", "2026-02", 1), "2026-11")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"])
    expect(addMonths("2026-12", 1)).toBe("2027-01")
    expect(addMonths("2026-01", -1)).toBe("2025-12")
  })
  test("one dated row per month, on the 1st, flat costs use the recurring model", () => {
    const rows = expandRecurringCosts({ costs: [seg(LOVABLE, "2026-10", null, 250)], manualRows: [], currentMonth: "2026-11" })
    expect(rows.map((r) => [r.date, r.provider_id, r.model_name, r.total_cost_usd, r.person_email])).toEqual([
      ["2026-10-01", LOVABLE, RECURRING_MODEL, 250, null],
      ["2026-11-01", LOVABLE, RECURRING_MODEL, 250, null],
    ])
  })
})

describe("change from a month", () => {
  // What set_recurring_cost() leaves after "4,000 from June" then "5,000 from September":
  // June-August keep 4,000, September on is 5,000.
  const costs = [seg(ULTRA, "2026-06", "2026-08", 4000, 20, 200), seg(ULTRA, "2026-09", null, 5000, 25, 200)]

  test("months before the change keep the old amount", () => {
    const rows = expandRecurringCosts({ costs, manualRows: [], currentMonth: "2026-11" })
    expect(byMonth(rows)).toEqual({ "2026-06": 4000, "2026-07": 4000, "2026-08": 4000, "2026-09": 5000, "2026-10": 5000, "2026-11": 5000 })
    expect(rows.every((r) => r.model_name === SEAT_MODEL)).toBe(true)
    expect(rows.find((r) => r.month === "2026-09")?.total_requests).toBe(25)
  })
  test("segmentFor finds the segment in force for a month", () => {
    expect(segmentFor(costs, ULTRA, "2026-07")?.monthly_cost_usd).toBe("4000.00")
    expect(segmentFor(costs, ULTRA, "2027-05")?.monthly_cost_usd).toBe("5000.00")
    expect(segmentFor(costs, ULTRA, "2026-05")).toBeNull()
    expect(segmentFor(costs, LOVABLE, "2026-07")).toBeNull()
  })
})

describe("single-month override by a manual entry", () => {
  const costs = [seg(GPT, "2026-08", null, 600)]

  test("a manual entry for the provider-month wins; other months keep the recurring cost", () => {
    const manualRows = [manual(GPT, "2026-10", 750)]
    const rows = expandRecurringCosts({ costs, manualRows, currentMonth: "2026-11" })
    expect(byMonth(rows)).toEqual({ "2026-08": 600, "2026-09": 600, "2026-11": 600 })
  })

  test("no double counting: recurring + manual rows total one amount per month", () => {
    const manualRows = [manual(GPT, "2026-10", 750), manual(GPT, "2026-09", 0, { collection_method: "csv_import" })]
    const rows = expandRecurringCosts({ costs, manualRows, currentMonth: "2026-11" })
    const totals: Record<string, number> = byMonth(rows)
    for (const m of manualRows) {
      const ym = String(m.metadata?.month)
      expect(totals[ym]).toBeUndefined() // never both
      totals[ym] = (totals[ym] ?? 0) + Number(m.cost_usd)
    }
    expect(totals).toEqual({ "2026-08": 600, "2026-09": 0, "2026-10": 750, "2026-11": 600 })
  })

  test("the month comes from metadata.month, else the timestamp", () => {
    const keys = manualMonthKeys([
      manual(GPT, "2026-10", 1, { timestamp: "2026-09-30T23:00:00Z" }),
      { ...manual(GPT, "2026-01", 1), metadata: {}, timestamp: "2026-07-01T12:00:00Z" },
    ])
    expect([...keys].sort()).toEqual([`${GPT}|2026-07`, `${GPT}|2026-10`])
  })

  test("API-collected rows don't override", () => {
    const rows = expandRecurringCosts({
      costs,
      manualRows: [manual(GPT, "2026-10", 5, { collection_method: "api" })],
      currentMonth: "2026-10",
    })
    expect(byMonth(rows)).toEqual({ "2026-08": 600, "2026-09": 600, "2026-10": 600 })
  })

  test("other providers' manual entries don't override", () => {
    const rows = expandRecurringCosts({ costs, manualRows: [manual(LOVABLE, "2026-09", 5)], currentMonth: "2026-09" })
    expect(byMonth(rows)).toEqual({ "2026-08": 600, "2026-09": 600 })
  })
})

describe("history is unchanged", () => {
  test("past months without a segment get nothing (a deliberately removed month stays empty)", () => {
    // Lovable April was removed on purpose; a recurring cost from June doesn't bring it back.
    const rows = expandRecurringCosts({ costs: [seg(LOVABLE, "2026-06", null, 100)], manualRows: [manual(LOVABLE, "2026-03", 80)], currentMonth: "2026-07" })
    expect(byMonth(rows)).toEqual({ "2026-06": 100, "2026-07": 100 })
  })
  test("an edited manual month keeps its edited amount", () => {
    // Claude Max May was set to $5,000 by hand; a recurring cost covering May doesn't change it.
    const rows = expandRecurringCosts({
      costs: [seg(ULTRA, "2026-04", null, 4000, 20, 200)],
      manualRows: [manual(ULTRA, "2026-05", 5000, { model_name: "seats" }, { entry_type: "monthly_seats", seats: 25, price_per_seat: 200 })],
      currentMonth: "2026-06",
    })
    expect(byMonth(rows)).toEqual({ "2026-04": 4000, "2026-06": 4000 })
  })
})

describe("sync-freshness warning suppression", () => {
  const providers: FreshnessProvider[] = [
    { id: GPT, name: "chatgpt", display_name: "ChatGPT", last_collected_at: null, metadata: { collection_method: "manual" } },
    { id: LOVABLE, name: "lovable", display_name: "Lovable", last_collected_at: null, metadata: { collection_method: "manual" } },
    { id: ULTRA, name: "claude-max", display_name: "Claude Ultra", last_collected_at: null, metadata: { collection_method: "manual" } },
  ]
  const now = new Date("2026-11-10T15:00:00Z") // day 10 in America/Chicago: past the reminder day
  const costs = [seg(GPT, "2026-01", null, 600), seg(LOVABLE, "2026-01", "2026-10", 100), seg(ULTRA, "2026-12", null, 1)]

  test("coveredProviderIds lists providers with a segment active that month", () => {
    expect([...coveredProviderIds(costs, "2026-11")]).toEqual([GPT])
    expect([...coveredProviderIds(costs, "2026-10")].sort()).toEqual([GPT, LOVABLE].sort())
  })

  test("a covered provider gets no 'no <month> entry' warning; uncovered ones still do", () => {
    const states = Object.fromEntries(
      computeFreshness({ providers, crons: [], manualEntryThisMonth: coveredProviderIds(costs, "2026-11") }, { now }).map((f) => [f.id, [f.state, f.warning]])
    )
    expect(states).toEqual({
      [GPT]: ["manual_ok", false],
      [LOVABLE]: ["manual_missing", true], // ended in October
      [ULTRA]: ["manual_missing", true], // starts in December
    })
  })

  test("without recurring costs (migration 022 not applied) the warnings are as before", () => {
    const states = computeFreshness({ providers, crons: [], manualEntryThisMonth: coveredProviderIds([], "2026-11") }, { now }).map((f) => f.state)
    expect(states).toEqual(["manual_missing", "manual_missing", "manual_missing"])
  })
})

describe("seat attribution (migration 016 splits)", () => {
  const index = buildOrgIndex(orgData())
  const resolve = (r: { provider_id: string; metadata: Record<string, unknown> }) => resolveAttribution(r, index)
  // May: 20 seats at $200, alice 2, dave 1, remainder 17 org-level.
  const may = seatSplit(ULTRA, "2026-05", 200, 20, [["alice@liatrio.com", 2], ["dave@liatrio.com", 1]])

  test("recurring seat months inherit the latest split: people get seats x price, the remainder is org-level", () => {
    const rows = expandRecurringCosts({ costs: [seg(ULTRA, "2026-06", null, 4400, 22, 200)], manualRows: may, currentMonth: "2026-07" })
    const june = rows.filter((r) => r.month === "2026-06").map((r) => [r.person_email, r.total_requests, r.total_cost_usd])
    expect(june).toEqual([
      ["alice@liatrio.com", 2, 400],
      ["dave@liatrio.com", 1, 200],
      [null, 19, 3800],
    ])
    expect(byMonth(rows)).toEqual({ "2026-06": 4400, "2026-07": 4400 })

    const attributed = attributeRecurringRows(rows, resolve)
    const alice = attributed.filter((r) => r.person_id === PE.alice)
    expect(alice.map((r) => [r.date, r.team_id, r.department_id, r.granularity])).toEqual([
      ["2026-06-01", T.platform, D.eng, "person"],
      ["2026-07-01", T.platform, D.eng, "person"],
    ])
    // Person and team views see the attributed share; the org total is unchanged.
    expect(applyFilters(attributed, { person: PE.dave }).reduce((s, r) => s + Number(r.total_cost_usd), 0)).toBe(400)
    expect(applyFilters(attributed, { team: T.platform }).reduce((s, r) => s + Number(r.total_cost_usd), 0)).toBe(800)
    expect(attributed.filter((r) => r.person_id === null).every((r) => r.granularity === "org")).toBe(true)
  })

  test("a later manual split takes over for the months after it", () => {
    const aug = seatSplit(ULTRA, "2026-08", 200, 22, [["bob@liatrio.com", 3]])
    const rows = expandRecurringCosts({ costs: [seg(ULTRA, "2026-06", null, 4400, 22, 200)], manualRows: [...may, ...aug], currentMonth: "2026-09" })
    expect(rows.filter((r) => r.person_email).map((r) => [r.month, r.person_email])).toEqual([
      ["2026-06", "alice@liatrio.com"],
      ["2026-06", "dave@liatrio.com"],
      ["2026-07", "alice@liatrio.com"],
      ["2026-07", "dave@liatrio.com"],
      ["2026-09", "bob@liatrio.com"],
    ])
    expect(rows.some((r) => r.month === "2026-08")).toBe(false) // the manual split month itself
  })

  test("a split that no longer fits the seat count stays org-level", () => {
    const rows = expandRecurringCosts({ costs: [seg(ULTRA, "2026-06", null, 400, 2, 200)], manualRows: may, currentMonth: "2026-06" })
    expect(rows.map((r) => [r.person_email, r.total_cost_usd])).toEqual([[null, 400]])
  })

  test("flat (non-seat) recurring costs are org-level", () => {
    const rows = expandRecurringCosts({ costs: [seg(ULTRA, "2026-06", null, 4000)], manualRows: may, currentMonth: "2026-06" })
    expect(rows.map((r) => [r.person_email, r.model_name])).toEqual([[null, RECURRING_MODEL]])
  })

  test("an unknown email stays person-granular with no person, like the attributed view", () => {
    const split = seatSplit(ULTRA, "2026-05", 10, 3, [["ghost@liatrio.com", 1]])
    const rows = attributeRecurringRows(
      expandRecurringCosts({ costs: [seg(ULTRA, "2026-06", null, 30, 3, 10)], manualRows: split, currentMonth: "2026-06" }),
      resolve
    )
    expect(rows.map((r) => [r.person_id, r.granularity, Number(r.total_cost_usd)])).toEqual([
      [null, "person", 10],
      [null, "org", 20],
    ])
  })
})

describe("projection", () => {
  test("recurring rows are seat spend: the current month projects exactly the recurring amount", () => {
    const now = new Date("2026-11-03T12:00:00Z")
    const ctx = projectionContext([{ id: LOVABLE, name: "lovable", last_collected_at: null }], now)
    const rows = attributeRecurringRows(expandRecurringCosts({ costs: [seg(LOVABLE, "2026-09", null, 250)], manualRows: [], currentMonth: "2026-11" }))
    const p = projectPeriod(rows, monthRange("2026-11"), ctx)!
    expect(p).toMatchObject({ actual: 250, projected: 250, seatActual: 250, usageActual: 0 })
  })
})

describe("parseRecurringInput", () => {
  test("amount, or seats x price to the cent", () => {
    expect(parseRecurringInput({ provider_id: "p", from_month: "2026-11", monthly_cost_usd: "99.999" })).toMatchObject({ monthly_cost_usd: 100, seats: null })
    expect(parseRecurringInput({ provider_id: "p", from_month: "2026-11", seats: 18, price_per_seat: 40.5, monthly_cost_usd: 1 })).toMatchObject({
      monthly_cost_usd: 729,
      seats: 18,
      price_per_seat: 40.5,
    })
  })
  test("end, end month and notes", () => {
    expect(parseRecurringInput({ provider_id: "p", from_month: "2026-12", end: true })).toEqual({ provider_id: "p", from_month: "2026-12", monthly_cost_usd: null })
    expect(parseRecurringInput({ provider_id: "p", from_month: "2026-11", monthly_cost_usd: 5, end_month: "2027-01", notes: "  x " })).toMatchObject({ end_month: "2027-01", notes: "x" })
  })
  test.each([
    [{ from_month: "2026-11", monthly_cost_usd: 1 }, "provider_id"],
    [{ provider_id: "p", from_month: "2026-1", monthly_cost_usd: 1 }, "from_month"],
    [{ provider_id: "p", from_month: "2026-11" }, "monthly_cost_usd"],
    [{ provider_id: "p", from_month: "2026-11", monthly_cost_usd: -1 }, "monthly_cost_usd"],
    [{ provider_id: "p", from_month: "2026-11", seats: 1.5, price_per_seat: 2 }, "seats"],
    [{ provider_id: "p", from_month: "2026-11", seats: 2 }, "price_per_seat"],
    [{ provider_id: "p", from_month: "2026-11", monthly_cost_usd: 1, end_month: "2026-10" }, "end_month"],
  ])("rejects %j", (body, field) => {
    expect(() => parseRecurringInput(body)).toThrow(RecurringInputError)
    expect(() => parseRecurringInput(body)).toThrow(field)
  })
})

test("isMissingRelation recognizes 'migration 022 not applied' errors only", () => {
  expect(isMissingRelation({ code: "42P01", message: 'relation "public.recurring_costs" does not exist' })).toBe(true)
  expect(isMissingRelation({ code: "PGRST205", message: "Could not find the table 'public.recurring_costs' in the schema cache" })).toBe(true)
  expect(isMissingRelation({ code: "PGRST202", message: "Could not find the function public.set_recurring_cost" })).toBe(true)
  expect(isMissingRelation({ code: "42501", message: "permission denied" })).toBe(false)
  expect(isMissingRelation(null)).toBe(false)
})
