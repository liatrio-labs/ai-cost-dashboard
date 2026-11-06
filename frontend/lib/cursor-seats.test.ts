/**
 * Cursor seat types per person and the seat fee per 20th-to-20th billing
 * cycle (migration 026, issue #82).
 * Pure functions only; the routes are covered in app/api/dashboard/routes.test.ts
 * and app/api/admin/org/cursor-seats/route.test.ts.
 */

import { readFileSync } from "fs"
import { join } from "path"
import {
  CURSOR_SEAT_MODEL,
  EMPTY_SEAT_PLAN,
  SEAT_CYCLE_ANCHOR_DAY,
  calendarMonthOfCycle,
  currentSeatCycle,
  seatCycle,
  seatCycleForMonth,
  seatCycleInProgress,
  seatCycleKeyForDate,
  applyCursorSeatPlan,
  applySpendPlans,
  composeSeatsWithInvoice,
  expandCursorSeats,
  isMissingSeatTables,
  parseFromMonth,
  parseRoster,
  parseSeatAssignInput,
  parseSeatRateInput,
  planRosterBackfill,
  rateFor,
  rosterRowSummary,
  rosterTotal,
  seatCostFor,
  seatSummary,
  seatTypeFor,
  type CursorSeatPlan,
  type SeatAssignment,
  type SeatRate,
} from "./cursor-seats"
import { applyInvoicePlan, buildInvoicePlan, EMPTY_INVOICE_PLAN, INVOICE_ADJUSTMENT_MODEL } from "./invoice-overrides"
import { RECURRING_MODEL } from "./projection"
import { attributeRecurringRows } from "./recurring-costs"

const ROSTER_CSV = readFileSync(join(__dirname, "..", "..", "database", "seeds", "cursor-seat-roster-2026-11-05.csv"), "utf8")
const CURSOR = "prov-cursor"

/** The migration's seeded rates: Standard $40, Premium $80, Free $0. */
const SEED_RATES: SeatRate[] = [
  { seat_type: "standard", effective_month: "2000-01-01", monthly_rate_usd: "40.00" },
  { seat_type: "premium", effective_month: "2000-01-01", monthly_rate_usd: "80.00" },
  { seat_type: "free", effective_month: "2000-01-01", monthly_rate_usd: "0.00" },
]
const DEFAULT = { standard: 40, premium: 80, free: 0 }

const slug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")

/**
 * People as the org tables would hold them for the roster: rows with an email
 * get that email (upper-cased, to prove the match is case-insensitive) and a
 * display name that differs from the roster's; rows without one get the exact
 * roster name and a first.last email.
 */
function rosterPeople(skip: string[] = []) {
  return parseRoster(ROSTER_CSV)
    .filter((r) => !skip.includes(r.name))
    .map((r, i) => ({
      id: `p${i}`,
      email: r.email ? r.email.toUpperCase() : `${slug(r.name)}@liatrio.com`,
      display_name: r.email ? `${r.name} (email match)` : r.name,
    }))
}

const sumCost = (rows: { total_cost_usd: number | string }[]) =>
  Math.round(rows.reduce((s, r) => s + Number(r.total_cost_usd), 0) * 100) / 100

describe("roster seed CSV", () => {
  it("is the Nov 5, 2026 roster: 74 Standard + 36 Premium + 1 Free active, 1 Removed = $5,840 at the seeded rates", () => {
    const rows = parseRoster(ROSTER_CSV)
    expect(rows).toHaveLength(112)
    const s = rosterRowSummary(rows, DEFAULT)
    expect(s.counts).toEqual({ standard: 74, premium: 36, free: 1, none: 1 })
    expect(s.total_usd).toBe(5840)
  })
})

describe("backfill from the Nov 5 roster assigns seat types by email (and name when email blank)", () => {
  it("matches every roster row to its person: email case-insensitively, exact name when the email is blank", () => {
    const people = rosterPeople()
    const plan = planRosterBackfill(parseRoster(ROSTER_CSV), people)
    expect(plan.unmatched).toEqual([])
    expect(plan.assignments).toHaveLength(112)
    const byEmail = plan.assignments.filter((a) => a.matched_by === "email")
    const byName = plan.assignments.filter((a) => a.matched_by === "name")
    expect(byEmail).toHaveLength(27)
    expect(byName).toHaveLength(85)

    const of = (name: string) => plan.assignments.find((a) => a.name === name)!
    // Email rows: "Robert Kelly,robert@liatrio.com" matches ROBERT@LIATRIO.COM.
    expect(of("Robert Kelly")).toMatchObject({ matched_by: "email", seat_type: "premium" })
    expect(people.find((p) => p.id === of("Robert Kelly").person_id)!.email).toBe("ROBERT@LIATRIO.COM")
    expect(of("Blair")).toMatchObject({ matched_by: "email", seat_type: "standard" })
    // Name rows.
    expect(of("Andrew Noble")).toMatchObject({ matched_by: "name", seat_type: "premium" })
    expect(of("Ahmad Atra")).toMatchObject({ matched_by: "name", seat_type: "standard" })
    expect(of("William Bedford")).toMatchObject({ matched_by: "name", seat_type: "free" })
    // Removed: matched, but no billed seat.
    expect(of("Daniel Helbling")).toMatchObject({ matched_by: "name", seat_type: "none", removed: true })

    expect(plan.counts).toEqual({ standard: 74, premium: 36, free: 1, none: 1 })
    expect(rosterTotal(plan, DEFAULT)).toBe(5840)
  })

  it("after backfill the seat line for the month is $5,840 and is attributed to each person", () => {
    const people = rosterPeople()
    const plan = planRosterBackfill(parseRoster(ROSTER_CSV), people)
    const assignments: SeatAssignment[] = plan.assignments.map((a) => ({ person_id: a.person_id, effective_month: "2026-11-01", seat_type: a.seat_type, source: "roster" }))
    const summary = seatSummary(assignments, SEED_RATES, people.map((p) => p.id), "2026-11")
    expect(summary).toMatchObject({ counts: { standard: 74, premium: 36, free: 1, none: 1 }, total_usd: 5840 })

    const rows = expandCursorSeats({ assignments, rates: SEED_RATES, people, cursorProviderId: CURSOR, currentMonth: "2026-11" })
    expect(rows).toHaveLength(110) // Free and Removed get no row
    expect(sumCost(rows)).toBe(5840)
    expect(rows.every((r) => r.month === "2026-11" && r.model_name === CURSOR_SEAT_MODEL && r.person_email)).toBe(true)
    const robert = people.find((p) => p.email === "ROBERT@LIATRIO.COM")!
    expect(rows.find((r) => r.person_email === robert.email)?.total_cost_usd).toBe(80)
  })

  it("reports unmatched rows and never invents people; an email row does not fall back to the name", () => {
    const people = rosterPeople(["Yujie Wu", "Robert Kelly"])
    // Robert's name exists on someone else's record but the roster row has an email: still unmatched.
    people.push({ id: "p-other", email: "rkelly@example.com", display_name: "Robert Kelly" })
    const plan = planRosterBackfill(parseRoster(ROSTER_CSV), people)
    expect(plan.unmatched.map((u) => [u.name, u.reason])).toEqual([
      ["Robert Kelly", "email_not_found"],
      ["Yujie Wu", "name_not_found"],
    ])
    expect(plan.assignments).toHaveLength(110)
    expect(plan.assignments.some((a) => a.person_id === "p-other")).toBe(false)
    expect(new Set(plan.assignments.map((a) => a.person_id)).size).toBe(110)
  })

  it("an exact name only: case or spacing differences and two people with the same name are unmatched", () => {
    const rows = parseRoster("name,email,role,seat_type\nAndrew Noble,,Member,Premium\nBen Sykes,,Member,Premium\nCasey Lee,,Member,Standard\n")
    const plan = planRosterBackfill(rows, [
      { id: "a", email: "a@x.com", display_name: "andrew noble" },
      { id: "b1", email: "b1@x.com", display_name: "Ben Sykes" },
      { id: "b2", email: "b2@x.com", display_name: "Ben Sykes" },
      { id: "c", email: "c@x.com", display_name: "  Casey Lee " },
    ])
    expect(plan.unmatched.map((u) => [u.name, u.reason])).toEqual([
      ["Andrew Noble", "name_not_found"],
      ["Ben Sykes", "name_ambiguous"],
    ])
    expect(plan.assignments.map((a) => [a.person_id, a.seat_type])).toEqual([["c", "standard"]])
  })

  it("rejects a CSV without the needed columns and reports unknown seat types", () => {
    expect(() => parseRoster("full_name,tier\nA,B\n")).toThrow(/name and seat_type/)
    const plan = planRosterBackfill(parseRoster('name,email,role,seat_type\n"Doe, Jane",jane@x.com,Member,Enterprise\n'), [
      { id: "j", email: "jane@x.com", display_name: "Jane" },
    ])
    expect(plan.unmatched).toEqual([{ line: 2, name: "Doe, Jane", email: "jane@x.com", seat_type: "Enterprise", reason: "unknown_seat_type" }])
  })
})

describe("changing a person's seat type updates their attributed seat cost", () => {
  const people = [{ id: "dave", email: "dave@liatrio.com" }]
  it("Standard in November, Premium from December: November stays $40, December is $80", () => {
    const before: SeatAssignment[] = [{ person_id: "dave", effective_month: "2026-11-01", seat_type: "standard" }]
    expect(seatCostFor(before, SEED_RATES, "dave", "2026-11")).toBe(40)
    const after: SeatAssignment[] = [...before, { person_id: "dave", effective_month: "2026-12-01", seat_type: "premium" }]
    expect(seatCostFor(after, SEED_RATES, "dave", "2026-11")).toBe(40)
    expect(seatCostFor(after, SEED_RATES, "dave", "2026-12")).toBe(80)
    const rows = expandCursorSeats({ assignments: after, rates: SEED_RATES, people, cursorProviderId: CURSOR, currentMonth: "2027-01" })
    expect(rows.map((r) => [r.month, r.total_cost_usd])).toEqual([
      ["2026-11", 40],
      ["2026-12", 80],
      ["2027-01", 80],
    ])
  })

  it("re-setting the same month replaces the type for that month", () => {
    const rows = expandCursorSeats({
      assignments: [{ person_id: "dave", effective_month: "2026-11-01", seat_type: "premium" }],
      rates: SEED_RATES,
      people,
      cursorProviderId: CURSOR,
      currentMonth: "2026-11",
    })
    expect(rows.map((r) => r.total_cost_usd)).toEqual([80])
  })

  it("seat rows attribute to the person (and so their team) like a manual seat row", () => {
    const rows = expandCursorSeats({
      assignments: [{ person_id: "dave", effective_month: "2026-11-01", seat_type: "premium" }],
      rates: SEED_RATES,
      people,
      cursorProviderId: CURSOR,
      currentMonth: "2026-11",
    })
    const attributed = attributeRecurringRows(rows, (rec) => ({
      person_id: (rec.metadata.attribution as { person_email: string }).person_email === "dave@liatrio.com" ? "dave" : null,
      team_id: "team-data",
      department_id: "dept-eng",
      org_api_key_id: null,
      project_id: null,
      workspace_id: null,
      granularity: "person",
    }))
    expect(attributed).toEqual([
      expect.objectContaining({ date: "2026-11-01", provider_id: CURSOR, person_id: "dave", team_id: "team-data", total_cost_usd: 80, model_name: CURSOR_SEAT_MODEL }),
    ])
  })
})

describe("Free / unassigned / Removed -> $0 billed seat", () => {
  const people = [
    { id: "free", email: "free@x.com" },
    { id: "none", email: "none@x.com" },
    { id: "nobody", email: "nobody@x.com" },
    { id: "std", email: "std@x.com" },
  ]
  const assignments: SeatAssignment[] = [
    { person_id: "free", effective_month: "2026-11-01", seat_type: "free" },
    { person_id: "none", effective_month: "2026-11-01", seat_type: "none" }, // unassigned / Removed
    { person_id: "std", effective_month: "2026-11-01", seat_type: "standard" },
  ]
  it("costs nothing and adds no row", () => {
    for (const id of ["free", "none", "nobody"]) expect(seatCostFor(assignments, SEED_RATES, id, "2026-11")).toBe(0)
    expect(seatTypeFor(assignments, "nobody", "2026-11")).toBe("none")
    const rows = expandCursorSeats({ assignments, rates: SEED_RATES, people, cursorProviderId: CURSOR, currentMonth: "2026-11" })
    expect(rows.map((r) => r.person_email)).toEqual(["std@x.com"])
  })

  it("a Removed roster row becomes none, whatever its seat_type column says", () => {
    const plan = planRosterBackfill(parseRoster("name,email,role,seat_type\nDaniel Helbling,,Removed,Standard\n"), [
      { id: "dh", email: "daniel.helbling@liatrio.com", display_name: "Daniel Helbling" },
    ])
    expect(plan.assignments).toEqual([expect.objectContaining({ person_id: "dh", seat_type: "none", removed: true })])
    expect(rosterTotal(plan, DEFAULT)).toBe(0)
  })

  it("unassigned is always $0, even if a rate row were somehow present", () => {
    expect(rateFor([...SEED_RATES, { seat_type: "none", effective_month: "2000-01-01", monthly_rate_usd: 99 }], "none", "2026-11")).toBe(0)
  })

  it("a person removed later stops being billed from that month only", () => {
    const rows = expandCursorSeats({
      assignments: [
        { person_id: "std", effective_month: "2026-11-01", seat_type: "standard" },
        { person_id: "std", effective_month: "2026-12-01", seat_type: "none" },
      ],
      rates: SEED_RATES,
      people,
      cursorProviderId: CURSOR,
      currentMonth: "2027-01",
    })
    expect(rows.map((r) => r.month)).toEqual(["2026-11"])
  })
})

describe("rates are configurable in admin", () => {
  const assignments: SeatAssignment[] = [
    { person_id: "a", effective_month: "2026-11-01", seat_type: "premium" },
    { person_id: "b", effective_month: "2026-11-01", seat_type: "standard" },
    { person_id: "c", effective_month: "2026-11-01", seat_type: "free" },
  ]
  const people = ["a", "b", "c"].map((id) => ({ id, email: `${id}@x.com` }))

  it("a rate change from a month applies from that month; earlier months keep the old rate", () => {
    const rates: SeatRate[] = [
      ...SEED_RATES,
      { seat_type: "premium", effective_month: "2026-12-01", monthly_rate_usd: "100.00" },
      { seat_type: "free", effective_month: "2026-12-01", monthly_rate_usd: "5" },
    ]
    const rows = expandCursorSeats({ assignments, rates, people, cursorProviderId: CURSOR, currentMonth: "2026-12" })
    expect(rows.map((r) => [r.month, r.person_email, r.total_cost_usd])).toEqual([
      ["2026-11", "a@x.com", 80],
      ["2026-11", "b@x.com", 40],
      ["2026-12", "a@x.com", 100],
      ["2026-12", "b@x.com", 40],
      ["2026-12", "c@x.com", 5],
    ])
    expect(seatSummary(assignments, rates, ["a", "b", "c"], "2026-12")).toMatchObject({ rates: { standard: 40, premium: 100, free: 5 }, total_usd: 145 })
  })

  it("validates rate input: known type, number >= 0, never a past month", () => {
    expect(parseSeatRateInput({ seat_type: "premium", monthly_rate_usd: "85.005" }, "2026-11")).toEqual({ seat_type: "premium", monthly_rate_usd: 85.01, from_month: "2026-11" })
    expect(parseSeatRateInput({ seat_type: "standard", monthly_rate_usd: 0, from_month: "2027-01" }, "2026-11").from_month).toBe("2027-01")
    expect(() => parseSeatRateInput({ seat_type: "none", monthly_rate_usd: 1 }, "2026-11")).toThrow(/seat_type/)
    expect(() => parseSeatRateInput({ seat_type: "premium", monthly_rate_usd: -1 }, "2026-11")).toThrow(/monthly_rate_usd/)
    expect(() => parseSeatRateInput({ seat_type: "premium", monthly_rate_usd: "abc" }, "2026-11")).toThrow(/monthly_rate_usd/)
    expect(() => parseSeatRateInput({ seat_type: "premium", monthly_rate_usd: 1, from_month: "2026-10" }, "2026-11")).toThrow(/past months/)
  })

  it("validates assignment input: known people and types, never a past month", () => {
    const known = new Set(["a", "b"])
    expect(parseSeatAssignInput({ person_id: "a", seat_type: "free" }, known, "2026-11")).toEqual({ person_ids: ["a"], seat_type: "free", from_month: "2026-11" })
    expect(parseSeatAssignInput({ person_ids: ["a", "b", "a"], seat_type: "none" }, known, "2026-11").person_ids).toEqual(["a", "b"])
    expect(() => parseSeatAssignInput({ person_ids: ["zz"], seat_type: "free" }, known, "2026-11")).toThrow(/Unknown person/)
    expect(() => parseSeatAssignInput({ person_ids: ["a"], seat_type: "ultra" }, known, "2026-11")).toThrow(/seat_type/)
    expect(() => parseFromMonth("2026-1", "2026-11")).toThrow(/YYYY-MM/)
  })
})

describe("no double-count against the invoice override", () => {
  // Two seat holders in October: Premium $80 + Standard $40 = $120.
  const people = [
    { id: "dave", email: "dave@liatrio.com" },
    { id: "alice", email: "alice@liatrio.com" },
  ]
  const assignments: SeatAssignment[] = [
    { person_id: "dave", effective_month: "2026-10-01", seat_type: "premium" },
    { person_id: "alice", effective_month: "2026-10-01", seat_type: "standard" },
  ]
  const seatRows = attributeRecurringRows(
    expandCursorSeats({ assignments, rates: SEED_RATES, people, cursorProviderId: CURSOR, currentMonth: "2026-11" })
  )
  const seats: CursorSeatPlan = { cursorProviderId: CURSOR, seatRows }
  // October Cursor on-demand: dave $30 + alice $10 = $40 (API).
  const api = [
    { date: "2026-10-05", provider_id: CURSOR, model_name: "auto", total_cost_usd: 30, person_id: "dave" },
    { date: "2026-10-06", provider_id: CURSOR, model_name: "auto", total_cost_usd: 10, person_id: "alice" },
    { date: "2026-11-02", provider_id: CURSOR, model_name: "auto", total_cost_usd: 7, person_id: "dave" },
  ]
  const invoice = (billed: number) =>
    buildInvoicePlan({
      overrides: [{ provider_id: CURSOR, month: "2026-10-01", billed_amount_usd: String(billed) }],
      basisRows: api.filter((r) => r.date.startsWith("2026-10")),
      manualRows: [],
    })
  const oct = (rows: { date: string; total_cost_usd: number | string }[]) => sumCost(rows.filter((r) => r.date.startsWith("2026-10")))
  const nov = (rows: { date: string; total_cost_usd: number | string }[]) => sumCost(rows.filter((r) => r.date.startsWith("2026-11")))

  it("an invoiced month totals the invoice: seats are composition inside it, usage gets the remainder", () => {
    const out = applySpendPlans(api, invoice(200), seats)
    expect(oct(out)).toBe(200)
    // Seats intact ($120), the $40 of usage scaled to the remaining $80.
    expect(sumCost(out.filter((r) => r.date.startsWith("2026-10") && r.model_name === CURSOR_SEAT_MODEL))).toBe(120)
    expect(sumCost(out.filter((r) => r.date.startsWith("2026-10") && r.model_name === "auto"))).toBe(80)
    // Without seat composition, #75 alone gives $200 for usage, and seats on top would make $320.
    expect(oct(applyInvoicePlan(api, invoice(200)))).toBe(200)
    expect(oct([...applyInvoicePlan(api, invoice(200)), ...seatRows])).toBe(320)
    // A month without an invoice keeps seats on top of usage.
    expect(nov(out)).toBe(7 + 120)
  })

  it("seats larger than the invoice are scaled into it; usage gets nothing", () => {
    const out = applySpendPlans(api, invoice(60), seats)
    expect(oct(out)).toBe(60)
    expect(sumCost(out.filter((r) => r.date.startsWith("2026-10") && r.model_name === "auto"))).toBe(0)
    const dave = out.find((r) => r.date === "2026-10-01" && r.model_name === CURSOR_SEAT_MODEL && r.total_cost_usd === 40)
    expect(dave).toBeDefined() // 80 x 60/120
  })

  it("an invoiced month with no usage gets an adjustment row for the remainder only", () => {
    const plan = buildInvoicePlan({
      overrides: [{ provider_id: CURSOR, month: "2026-10-01", billed_amount_usd: "150.00" }],
      basisRows: [],
      manualRows: [],
    })
    type Row = { date: string; provider_id: string; model_name: string; total_cost_usd: number | string }
    const out = applySpendPlans<Row>([], plan, seats)
    expect(oct(out)).toBe(150)
    expect(out.filter((r) => r.model_name === INVOICE_ADJUSTMENT_MODEL).map((r) => r.total_cost_usd)).toEqual([30])
    // Exactly the invoice: no adjustment row.
    const exact = buildInvoicePlan({ overrides: [{ provider_id: CURSOR, month: "2026-10-01", billed_amount_usd: "120" }], basisRows: [], manualRows: [] })
    const out2 = applySpendPlans<Row>([], exact, seats)
    expect(oct(out2)).toBe(120)
    expect(out2.some((r) => r.model_name === INVOICE_ADJUSTMENT_MODEL)).toBe(false)
  })

  it("filtered views use the org-wide factor, so people still sum to the invoice", () => {
    const plan = invoice(200)
    const all = applySpendPlans(api, plan, seats)
    const daveOnly = applySpendPlans(api.filter((r) => r.person_id === "dave"), plan, seats).filter((r) => (r as { person_id?: string | null }).person_id === "dave" || (r as { person_email?: string }).person_email === "dave@liatrio.com")
    const aliceUsage = all.filter((r) => r.date.startsWith("2026-10") && (r as { person_id?: string }).person_id === "alice")
    expect(oct(daveOnly.filter((r) => r.model_name === "auto"))).toBe(60) // 30 x 80/40
    expect(oct(aliceUsage)).toBe(20)
  })

  it("a recurring Cursor seat line in a month with per-person seats is dropped (same dollars twice)", () => {
    const recurring = [
      { date: "2026-10-01", provider_id: CURSOR, model_name: RECURRING_MODEL, total_cost_usd: 5840 },
      { date: "2026-09-01", provider_id: CURSOR, model_name: RECURRING_MODEL, total_cost_usd: 5840 },
      { date: "2026-10-01", provider_id: "prov-lovable", model_name: RECURRING_MODEL, total_cost_usd: 90 },
    ]
    const out = applySpendPlans([...api, ...recurring], EMPTY_INVOICE_PLAN, seats)
    expect(oct(out)).toBe(40 + 120 + 90)
    // September has no seat rows: the recurring line stays.
    expect(sumCost(out.filter((r) => r.date.startsWith("2026-09")))).toBe(5840)
  })

  it("no seats: the invoice plan applies exactly as before", () => {
    expect(applySpendPlans(api, invoice(200), EMPTY_SEAT_PLAN)).toEqual(applyInvoicePlan(api, invoice(200)))
    expect(composeSeatsWithInvoice(EMPTY_SEAT_PLAN, invoice(200)).invoice).toEqual(invoice(200))
    expect(applyCursorSeatPlan(api, EMPTY_SEAT_PLAN)).toBe(api)
  })
})

describe("safe without migration 026 (missing-table fallback)", () => {
  it("recognizes PostgREST / Postgres missing-table and missing-function errors", () => {
    expect(isMissingSeatTables({ code: "PGRST205", message: "Could not find the table 'public.cursor_seat_assignments' in the schema cache" })).toBe(true)
    expect(isMissingSeatTables({ code: "42P01", message: 'relation "public.cursor_seat_rates" does not exist' })).toBe(true)
    expect(isMissingSeatTables({ code: "PGRST202", message: "Could not find the function public.set_cursor_seat_rate" })).toBe(true)
    expect(isMissingSeatTables({ message: 'relation "cursor_seat_rates" does not exist' })).toBe(true)
    expect(isMissingSeatTables({ code: "42501", message: "permission denied for table cursor_seat_rates" })).toBe(false)
    expect(isMissingSeatTables(null)).toBe(false)
  })

  it("no assignments means no seat rows and rows pass through untouched", () => {
    expect(expandCursorSeats({ assignments: [], rates: SEED_RATES, people: [], cursorProviderId: CURSOR, currentMonth: "2026-11" })).toEqual([])
    const rows = [{ date: "2026-11-01", provider_id: CURSOR, model_name: "auto", total_cost_usd: 1 }]
    expect(applySpendPlans(rows, EMPTY_INVOICE_PLAN, EMPTY_SEAT_PLAN)).toBe(rows)
  })
})

// ---------------------------------------------------------------------------
// Issue #82: 20th-to-20th billing cycles, carry-forward, backfill, invoices
// ---------------------------------------------------------------------------

describe("20th-to-20th seat billing cycles (issue #82)", () => {
  it("the anchor is one constant, the 20th", () => {
    expect(SEAT_CYCLE_ANCHOR_DAY).toBe(20)
  })

  it("cycle window vs calendar month (boundaries on the 19th/20th/21st)", () => {
    // A cycle is keyed by its start month and runs anchor to anchor, end exclusive.
    expect(seatCycle("2026-10")).toEqual({ key: "2026-10", start: "2026-10-20", end: "2026-11-20", label: "Oct 20 – Nov 20, 2026" })
    expect(seatCycle("2026-11")).toEqual({ key: "2026-11", start: "2026-11-20", end: "2026-12-20", label: "Nov 20 – Dec 20, 2026" })
    expect(seatCycle("2026-12").label).toBe("Dec 20, 2026 – Jan 20, 2027")

    // Date -> the cycle containing it.
    expect(seatCycleKeyForDate("2026-11-19")).toBe("2026-10") // last day of Oct 20 – Nov 20
    expect(seatCycleKeyForDate("2026-11-20")).toBe("2026-11") // first day of Nov 20 – Dec 20
    expect(seatCycleKeyForDate("2026-11-21")).toBe("2026-11")
    expect(seatCycleKeyForDate("2026-11-01")).toBe("2026-10")
    expect(seatCycleKeyForDate("2027-01-19")).toBe("2026-12")
    expect(seatCycleKeyForDate("2027-01-20T00:00:00Z")).toBe("2027-01")
    expect(seatCycleInProgress(new Date("2026-11-19T23:59:59Z")).label).toBe("Oct 20 – Nov 20, 2026")
    expect(seatCycleInProgress(new Date("2026-11-20T00:00:00Z")).label).toBe("Nov 20 – Dec 20, 2026")
    expect(seatCycleInProgress(new Date("2026-11-21T12:00:00Z")).key).toBe("2026-11")

    // Calendar month -> the one cycle whose charge lands in it (the cycle that
    // starts, and is billed, in that month). Edits default to it whatever the day.
    for (const d of ["2026-11-01", "2026-11-06", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-30"]) {
      expect(currentSeatCycle(new Date(`${d}T12:00:00Z`)).label).toBe("Nov 20 – Dec 20, 2026")
    }
    // Every calendar month holds exactly one cycle and the cycles tile with no gap or overlap.
    const months = ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"]
    const cycles = months.map((m) => seatCycleForMonth(m))
    expect(new Set(cycles.map((c) => c.key)).size).toBe(months.length)
    expect(cycles.map((c) => calendarMonthOfCycle(c.key))).toEqual(months)
    for (let i = 1; i < cycles.length; i++) expect(cycles[i].start).toBe(cycles[i - 1].end)

    // Expanded rows land in the cycle's start month, dated the 1st.
    const rows = expandCursorSeats({
      assignments: [{ person_id: "a", effective_month: "2026-11-01", seat_type: "standard" }],
      rates: SEED_RATES,
      people: [{ id: "a", email: "a@x.com" }],
      cursorProviderId: CURSOR,
      currentMonth: "2026-12",
    })
    expect(rows.map((r) => [r.date, r.total_cost_usd])).toEqual([
      ["2026-11-01", 40], // Nov 20 – Dec 20
      ["2026-12-01", 40], // Dec 20 – Jan 20
    ])

    // A different anchor moves the dates shown, not the month a cycle lands in.
    expect(seatCycle("2026-11", 19).label).toBe("Nov 19 – Dec 19, 2026")
    expect(seatCycleKeyForDate("2026-11-19", 19)).toBe("2026-11")
  })

  const people = [
    { id: "dave", email: "dave@liatrio.com" },
    { id: "erin", email: "erin@liatrio.com" },
  ]
  const expand = (assignments: SeatAssignment[], currentMonth: string) =>
    expandCursorSeats({ assignments, rates: SEED_RATES, people, cursorProviderId: CURSOR, currentMonth })

  it("assignment carries into the next cycle until removed", () => {
    // One row, entered once for Nov 20 – Dec 20; nothing re-entered after that.
    const assignments: SeatAssignment[] = [{ person_id: "dave", effective_month: "2026-11-01", seat_type: "premium", source: "admin" }]
    for (const cycle of ["2026-11", "2026-12", "2027-01", "2027-06"]) {
      expect(seatTypeFor(assignments, "dave", cycle)).toBe("premium")
      expect(seatCostFor(assignments, SEED_RATES, "dave", cycle)).toBe(80)
    }
    expect(seatTypeFor(assignments, "dave", "2026-10")).toBe("none") // before it took effect
    const rows = expand(assignments, "2027-03")
    expect(rows.map((r) => [r.month, r.person_email, r.total_cost_usd])).toEqual([
      ["2026-11", "dave@liatrio.com", 80],
      ["2026-12", "dave@liatrio.com", 80],
      ["2027-01", "dave@liatrio.com", 80],
      ["2027-02", "dave@liatrio.com", 80],
      ["2027-03", "dave@liatrio.com", 80],
    ])
    // A change of type from a later cycle carries forward too.
    const changed = [...assignments, { person_id: "dave", effective_month: "2027-01-01", seat_type: "standard" }]
    expect(expand(changed, "2027-03").map((r) => r.total_cost_usd)).toEqual([80, 80, 40, 40, 40])
  })

  it("removal (none) stops future cycles; earlier cycles unchanged", () => {
    const before: SeatAssignment[] = [
      { person_id: "dave", effective_month: "2026-11-01", seat_type: "standard" },
      { person_id: "erin", effective_month: "2026-11-01", seat_type: "premium" },
    ]
    const beforeRows = expand(before, "2027-02")
    // Erin removed from the Jan 20 – Feb 20, 2027 cycle onward.
    const after: SeatAssignment[] = [...before, { person_id: "erin", effective_month: "2027-01-01", seat_type: "none" }]
    const afterRows = expand(after, "2027-02")
    const byMonth = (rows: typeof afterRows, ym: string) => sumCost(rows.filter((r) => r.month === ym))
    // Earlier cycles: identical rows.
    for (const ym of ["2026-11", "2026-12"]) {
      expect(afterRows.filter((r) => r.month === ym)).toEqual(beforeRows.filter((r) => r.month === ym))
      expect(byMonth(afterRows, ym)).toBe(120)
    }
    // From the removal on, Erin has no row; Dave keeps carrying forward.
    for (const ym of ["2027-01", "2027-02"]) {
      expect(afterRows.filter((r) => r.month === ym).map((r) => r.person_email)).toEqual(["dave@liatrio.com"])
      expect(byMonth(afterRows, ym)).toBe(40)
    }
    expect(seatTypeFor(after, "erin", "2026-12")).toBe("premium")
    expect(seatTypeFor(after, "erin", "2027-05")).toBe("none")
    // A past cycle cannot be targeted: the default and minimum is the cycle billed this month.
    expect(() => parseSeatAssignInput({ person_id: "erin", seat_type: "none", from_month: "2026-10" }, new Set(["erin"]), "2026-11")).toThrow(
      /current cycle \(2026-11, Nov 20 – Dec 20, 2026\)/
    )
    expect(parseSeatAssignInput({ person_id: "erin", seat_type: "none" }, new Set(["erin"]), currentSeatCycle(new Date("2026-11-06T12:00:00Z")).key).from_month).toBe("2026-11")
  })

  /**
   * The production backfill of Nov 5, 2026: 107 matched people, all with
   * effective_month 2026-11-01 -> 70 Standard, 35 Premium, 1 Free (William
   * Bedford), 1 none (Daniel Helbling, Removed). $5,600 per cycle at $40/$80/$0.
   */
  function productionBackfill() {
    const ppl: { id: string; email: string }[] = []
    const rows: SeatAssignment[] = []
    const add = (n: number, type: string, prefix: string) => {
      for (let i = 0; i < n; i++) {
        const id = `${prefix}${String(i).padStart(3, "0")}`
        ppl.push({ id, email: `${id}@liatrio.com` })
        rows.push({ person_id: id, effective_month: "2026-11-01", seat_type: type, source: "roster", set_by: "robert@liatrio.com" })
      }
    }
    add(70, "standard", "std")
    add(35, "premium", "prem")
    add(1, "free", "william.bedford")
    add(1, "none", "daniel.helbling")
    return { people: ppl, assignments: rows }
  }

  it("existing 2026-11-01 backfill rows still apply and carry forward", () => {
    const { people: ppl, assignments } = productionBackfill()
    expect(assignments).toHaveLength(107)
    const ids = ppl.map((p) => p.id)
    // effective_month 2026-11-01 = from the Nov 20 – Dec 20, 2026 cycle (billed in November) onward.
    const nov = seatSummary(assignments, SEED_RATES, ids, "2026-11")
    expect(nov).toMatchObject({ month: "2026-11", counts: { standard: 70, premium: 35, free: 1, none: 1 }, total_usd: 5600 })
    expect(nov.cycle.label).toBe("Nov 20 – Dec 20, 2026")
    // The Oct 20 – Nov 20 cycle (billed in October) is before the backfill: no seats, as before #82.
    expect(seatSummary(assignments, SEED_RATES, ids, "2026-10").total_usd).toBe(0)

    // On Nov 6 (the current calendar month is November) November already carries the cycle, exactly as under 026.
    const now = expandCursorSeats({ assignments, rates: SEED_RATES, people: ppl, cursorProviderId: CURSOR, currentMonth: "2026-11" })
    expect(now).toHaveLength(105)
    expect(sumCost(now)).toBe(5600)
    expect(now.every((r) => r.date === "2026-11-01")).toBe(true)
    expect(now.some((r) => r.person_email.startsWith("william.bedford") || r.person_email.startsWith("daniel.helbling"))).toBe(false)

    // No re-import: the same 107 rows bill every later cycle.
    const later = expandCursorSeats({ assignments, rates: SEED_RATES, people: ppl, cursorProviderId: CURSOR, currentMonth: "2027-04" })
    for (const ym of ["2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04"]) {
      expect(sumCost(later.filter((r) => r.month === ym))).toBe(5600)
      expect(later.filter((r) => r.month === ym)).toHaveLength(105)
    }
    expect(later.some((r) => r.month > "2027-04" || r.month < "2026-11")).toBe(false)
  })

  describe("no double-count with invoice_overrides (Sep/Oct invoiced months)", () => {
    const { people: ppl, assignments: backfill } = productionBackfill()
    // Production invoice actuals (migration 024); they already include the seat lines billed on the 19th.
    const OVERRIDES = [
      { provider_id: CURSOR, month: "2026-09-01", billed_amount_usd: "9429.08" },
      { provider_id: CURSOR, month: "2026-10-01", billed_amount_usd: "11282.40" },
    ]
    const api = [
      { date: "2026-09-10", provider_id: CURSOR, model_name: "auto", total_cost_usd: 1500, person_id: "std000" },
      { date: "2026-10-10", provider_id: CURSOR, model_name: "auto", total_cost_usd: 2500, person_id: "prem000" },
      { date: "2026-11-03", provider_id: CURSOR, model_name: "auto", total_cost_usd: 300, person_id: "std001" },
    ]
    const plan = buildInvoicePlan({ overrides: OVERRIDES, basisRows: api.filter((r) => r.date < "2026-11"), manualRows: [] })
    const monthSum = (rows: { date: string; total_cost_usd: number | string }[], ym: string) => sumCost(rows.filter((r) => r.date.startsWith(ym)))
    const seatPlan = (assignments: SeatAssignment[]): CursorSeatPlan => ({
      cursorProviderId: CURSOR,
      seatRows: attributeRecurringRows(expandCursorSeats({ assignments, rates: SEED_RATES, people: ppl, cursorProviderId: CURSOR, currentMonth: "2026-11" })),
    })

    it("the backfill leaves Sep and Oct at their invoices and adds the Nov 20 cycle to November only", () => {
      const out = applySpendPlans(api, plan, seatPlan(backfill))
      expect(monthSum(out, "2026-09")).toBe(9429.08)
      expect(monthSum(out, "2026-10")).toBe(11282.4)
      expect(monthSum(out, "2026-11")).toBe(300 + 5600)
    })

    it("seats in an invoiced month are composition inside the invoice, never on top", () => {
      // Suppose seats had been recorded from the Sep 20 cycle: Sep and Oct each carry a $5,600 cycle.
      const fromSep = backfill.map((a) => ({ ...a, effective_month: "2026-09-01" }))
      const seats = seatPlan(fromSep)
      const out = applySpendPlans(api, plan, seats)
      expect(monthSum(out, "2026-09")).toBe(9429.08)
      expect(monthSum(out, "2026-10")).toBe(11282.4)
      const seatIn = (ym: string) => sumCost(out.filter((r) => r.date.startsWith(ym) && r.model_name === CURSOR_SEAT_MODEL))
      expect(seatIn("2026-09")).toBe(5600)
      expect(seatIn("2026-10")).toBe(5600)
      // On-demand usage gets the remainder of each invoice.
      expect(sumCost(out.filter((r) => r.date.startsWith("2026-09") && r.model_name === "auto"))).toBe(3829.08)
      expect(sumCost(out.filter((r) => r.date.startsWith("2026-10") && r.model_name === "auto"))).toBe(5682.4)
      // Adding seats on top of the invoice would have overcounted each month by $5,600.
      expect(monthSum([...applyInvoicePlan(api, plan), ...seats.seatRows], "2026-10")).toBe(11282.4 + 5600)
      // One cycle per invoiced month: never two cycles' charges in one month.
      expect(seats.seatRows.filter((r) => r.date.startsWith("2026-10"))).toHaveLength(105)
    })
  })
})
