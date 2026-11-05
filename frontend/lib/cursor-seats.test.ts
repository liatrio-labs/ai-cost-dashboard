/**
 * Cursor seat types per person and the monthly seat fee (migration 026).
 * Pure functions only; the routes are covered in app/api/dashboard/routes.test.ts
 * and app/api/admin/org/cursor-seats/route.test.ts.
 */

import { readFileSync } from "fs"
import { join } from "path"
import {
  CURSOR_SEAT_MODEL,
  EMPTY_SEAT_PLAN,
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
