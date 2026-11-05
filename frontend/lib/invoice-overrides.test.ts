/**
 * Invoice actuals per provider-month (issue #75): the pure plan and its
 * application. Route-level behavior (dashboard, breakdown, budgets, admin,
 * missing table) is in the route tests.
 */

import {
  EMPTY_INVOICE_PLAN,
  INVOICE_ADJUSTMENT_MODEL,
  InvoiceInputError,
  applyInvoicePlan,
  applyInvoicePlanToRaw,
  buildInvoicePlan,
  isMissingInvoiceTable,
  parseInvoiceOverrideInput,
  type BasisRow,
  type ManualBasisRow,
} from "./invoice-overrides"
import { RECURRING_MODEL } from "./projection"
import { isAutomationRow } from "./org/rollup"

const CURSOR = "prov-cursor"
const OTHER = "prov-other"

type Row = {
  date: string
  provider_id: string
  model_name: string
  total_cost_usd: number
  person_id: string | null
  team_id: string | null
  granularity: string
}

const row = (date: string, cost: number, person: string | null, model = "auto", provider = CURSOR, team: string | null = null): Row => ({
  date,
  provider_id: provider,
  model_name: model,
  total_cost_usd: cost,
  person_id: person,
  team_id: team,
  granularity: person ? "person" : "org",
})

/** The plain rollup (cost_records_daily) of attributed rows: summed by date + model. */
function basisOf(rows: Row[]): BasisRow[] {
  const m = new Map<string, BasisRow>()
  for (const r of rows) {
    const k = `${r.provider_id}|${r.date}|${r.model_name}`
    const b = m.get(k) ?? { date: r.date, provider_id: r.provider_id, model_name: r.model_name, total_cost_usd: 0 }
    b.total_cost_usd = Number(b.total_cost_usd) + r.total_cost_usd
    m.set(k, b)
  }
  return [...m.values()]
}

const sum = (rows: { total_cost_usd: number | string }[]) => rows.reduce((s, r) => s + Number(r.total_cost_usd), 0)
const inMonth = (rows: Row[], ym: string, provider = CURSOR) => rows.filter((r) => r.provider_id === provider && r.date.startsWith(ym))

// September: alice 300, bob 100 (team-b), automation 600 -> API 1,000.
const SEPT: Row[] = [
  row("2026-09-03", 300, "alice", "auto", CURSOR, "team-a"),
  row("2026-09-04", 100, "bob", "sonnet", CURSOR, "team-b"),
  row("2026-09-05", 600, null),
]
const OCT: Row[] = [row("2026-10-02", 500, "alice", "auto", CURSOR, "team-a")]
const OTHER_SEPT: Row[] = [row("2026-09-03", 42, "alice", "gpt", OTHER, "team-a")]
const ALL = [...SEPT, ...OCT, ...OTHER_SEPT]

const override = (month: string, amount: number | string, provider = CURSOR) => ({ provider_id: provider, month: `${month}-01`, billed_amount_usd: amount })

describe("override vs no override", () => {
  it("no override: rows pass through unchanged (same array)", () => {
    expect(applyInvoicePlan(ALL, EMPTY_INVOICE_PLAN)).toBe(ALL)
    const plan = buildInvoicePlan({ overrides: [], basisRows: basisOf(ALL), manualRows: [] })
    expect(applyInvoicePlan(ALL, plan)).toBe(ALL)
  })

  it("an overridden provider-month totals exactly the invoiced amount; other months and providers are unchanged", () => {
    const plan = buildInvoicePlan({ overrides: [override("2026-09", 250)], basisRows: basisOf(ALL), manualRows: [] })
    const out = applyInvoicePlan(ALL, plan)
    expect(sum(inMonth(out, "2026-09"))).toBeCloseTo(250, 6)
    expect(sum(inMonth(out, "2026-10"))).toBe(500)
    expect(sum(out.filter((r) => r.provider_id === OTHER))).toBe(42)
    const p = plan.months.get(`${CURSOR}|2026-09`)!
    expect(p.api_usd).toBe(1000)
    expect(p.factor).toBeCloseTo(0.25, 9)
  })

  it("invoice above usage scales up; an invoice of 0 zeroes the month", () => {
    const up = applyInvoicePlan(ALL, buildInvoicePlan({ overrides: [override("2026-10", "750.00")], basisRows: basisOf(ALL), manualRows: [] }))
    expect(sum(inMonth(up, "2026-10"))).toBeCloseTo(750, 6)
    const zero = applyInvoicePlan(ALL, buildInvoicePlan({ overrides: [override("2026-09", 0)], basisRows: basisOf(ALL), manualRows: [] }))
    expect(sum(inMonth(zero, "2026-09"))).toBe(0)
    expect(zero.filter((r) => r.model_name === INVOICE_ADJUSTMENT_MODEL)).toEqual([])
  })

  it("a month with no API spend gets one org-level invoice adjustment row with the whole invoice", () => {
    const plan = buildInvoicePlan({ overrides: [override("2026-08", 4240)], basisRows: basisOf(ALL), manualRows: [] })
    const out = applyInvoicePlan(ALL, plan)
    const adj = out.filter((r) => r.model_name === INVOICE_ADJUSTMENT_MODEL)
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ date: "2026-08-01", provider_id: CURSOR, total_cost_usd: 4240, person_id: null, team_id: null, granularity: "org" })
    // A bill, not Cursor automation (issue #51): stays Unassigned.
    expect(isAutomationRow(adj[0], new Set([CURSOR]))).toBe(false)
    // A provider filter for another provider gets no adjustment row.
    expect(applyInvoicePlan(ALL, plan, { providerId: OTHER }).some((r) => r.model_name === INVOICE_ADJUSTMENT_MODEL)).toBe(false)
  })

  it("tokens and requests are not scaled", () => {
    const rows = [{ ...SEPT[0], total_tokens: 1234, total_requests: 7 }]
    const plan = buildInvoicePlan({ overrides: [override("2026-09", 30)], basisRows: basisOf(rows), manualRows: [] })
    expect(applyInvoicePlan(rows, plan)[0]).toMatchObject({ total_cost_usd: 30, total_tokens: 1234, total_requests: 7 })
  })
})

describe("attribution", () => {
  const plan = buildInvoicePlan({ overrides: [override("2026-09", 250)], basisRows: basisOf(ALL), manualRows: [] })
  const out = applyInvoicePlan(ALL, plan)

  it("keeps every API row with its attribution, scaled by the same factor", () => {
    const sept = inMonth(out, "2026-09")
    expect(sept.map((r) => [r.person_id, r.team_id, r.model_name])).toEqual(SEPT.map((r) => [r.person_id, r.team_id, r.model_name]))
    expect(sept.map((r) => r.total_cost_usd)).toEqual([75, 25, 150])
  })

  it("a filtered subset (one person / one team) scales by the org-wide factor, so views reconcile with the org total", () => {
    // The factor comes from the full rollup basis, not from the rows passed in.
    const alice = applyInvoicePlan(SEPT.filter((r) => r.person_id === "alice"), plan)
    const teamB = applyInvoicePlan(SEPT.filter((r) => r.team_id === "team-b"), plan)
    const unassigned = applyInvoicePlan(SEPT.filter((r) => !r.team_id), plan)
    expect(sum(alice)).toBe(75)
    expect(sum(teamB)).toBe(25)
    expect(sum(alice) + sum(teamB) + sum(unassigned)).toBeCloseTo(250, 6)
  })

  it("raw records (product split) scale the same way as their rollup rows", () => {
    const raw = [
      { provider_id: CURSOR, timestamp: "2026-09-03T10:00:00Z", model_name: "auto", cost_usd: 300 },
      { provider_id: CURSOR, timestamp: "2026-09-04T10:00:00Z", model_name: "sonnet", cost_usd: "100" },
      { provider_id: CURSOR, timestamp: "2026-10-02T10:00:00Z", model_name: "auto", cost_usd: 500 },
    ]
    expect(applyInvoicePlanToRaw(raw, plan).map((r) => Number(r.cost_usd))).toEqual([75, 25, 500])
  })
})

describe("no double count with recurring / manual", () => {
  const manual = (month: string, cost: number, model = "manual", method = "manual_entry"): ManualBasisRow => ({
    provider_id: CURSOR,
    timestamp: `${month}-01T12:00:00Z`,
    model_name: model,
    cost_usd: cost,
    collection_method: method,
  })

  it("drops the month's recurring rows and manual entries; the invoice replaces them", () => {
    // September also has a manual seat-fee entry (in the rollup) and a recurring row (synthetic).
    const manualRows = [manual("2026-09", 5840, "seats"), manual("2026-10", 77)]
    const seatRollup = [row("2026-09-01", 5840, null, "seats")]
    const octManual = [row("2026-10-01", 77, null, "manual")]
    const recurring = [row("2026-09-01", 1000, null, RECURRING_MODEL), row("2026-10-01", 1000, null, RECURRING_MODEL)]
    const rows = [...SEPT, ...seatRollup, ...OCT, ...octManual, ...recurring]
    const plan = buildInvoicePlan({ overrides: [override("2026-09", 9429.08)], basisRows: basisOf([...SEPT, ...seatRollup, ...OCT, ...octManual]), manualRows })
    const p = plan.months.get(`${CURSOR}|2026-09`)!
    expect(p.api_usd).toBe(1000)
    expect(p.manual_usd).toBe(5840)

    const out = applyInvoicePlan(rows, plan)
    const sept = inMonth(out, "2026-09")
    expect(sum(sept)).toBeCloseTo(9429.08, 6)
    expect(sept.some((r) => r.model_name === "seats" || r.model_name === RECURRING_MODEL)).toBe(false)
    // October (not overridden) keeps API + manual + recurring.
    expect(sum(inMonth(out, "2026-10"))).toBe(500 + 77 + 1000)
  })

  it("a manual entry sharing an API row's date and model removes only the manual part", () => {
    const api = row("2026-09-01", 200, "alice", "manual")
    const man = row("2026-09-01", 50, null, "manual")
    const plan = buildInvoicePlan({ overrides: [override("2026-09", 400)], basisRows: basisOf([api, man]), manualRows: [manual("2026-09", 50)] })
    expect(plan.months.get(`${CURSOR}|2026-09`)!.api_usd).toBe(200)
    const out = applyInvoicePlan([api, man], plan)
    expect(sum(out)).toBeCloseTo(400, 6)
  })

  it("csv_import counts as manual; api_automated rows in cost_records are not manual", () => {
    const plan = buildInvoicePlan({
      overrides: [override("2026-09", 100)],
      basisRows: basisOf([row("2026-09-01", 30, null, "manual"), row("2026-09-02", 70, null, "auto")]),
      manualRows: [manual("2026-09", 30, "manual", "csv_import"), { ...manual("2026-09", 70, "auto", "api_automated"), timestamp: "2026-09-02T00:00:00Z" }],
    })
    expect(plan.months.get(`${CURSOR}|2026-09`)).toMatchObject({ api_usd: 70, manual_usd: 30 })
  })

  it("a month with only manual / recurring spend gets the adjustment row instead", () => {
    const rows = [row("2026-09-01", 5840, null, "seats"), row("2026-09-01", 1000, null, RECURRING_MODEL)]
    const plan = buildInvoicePlan({ overrides: [override("2026-09", 6000)], basisRows: basisOf([rows[0]]), manualRows: [manual("2026-09", 5840, "seats")] })
    const out = applyInvoicePlan(rows, plan)
    expect(out.map((r) => [r.model_name, r.total_cost_usd])).toEqual([[INVOICE_ADJUSTMENT_MODEL, 6000]])
  })
})

describe("missing-table fallback", () => {
  it("recognises the PostgREST / Postgres missing-table errors", () => {
    expect(isMissingInvoiceTable({ code: "PGRST205", message: "Could not find the table 'public.invoice_overrides' in the schema cache" })).toBe(true)
    expect(isMissingInvoiceTable({ code: "42P01", message: 'relation "public.invoice_overrides" does not exist' })).toBe(true)
    expect(isMissingInvoiceTable({ code: "42501", message: "permission denied" })).toBe(false)
    expect(isMissingInvoiceTable(null)).toBe(false)
  })
})

describe("parseInvoiceOverrideInput", () => {
  const ok = { provider_id: CURSOR, month: "2026-09", billed_amount_usd: "9429.084" }

  it("normalises a valid body", () => {
    expect(parseInvoiceOverrideInput({ ...ok, credits_usd: "12.5", invoice_ids: "INV-1, INV-2 INV-1", notes: "  trial  " }, "2026-11")).toEqual({
      provider_id: CURSOR,
      month: "2026-09",
      billed_amount_usd: 9429.08,
      credits_usd: 12.5,
      invoice_ids: ["INV-1", "INV-2"],
      notes: "trial",
    })
    expect(parseInvoiceOverrideInput({ ...ok, billed_amount_usd: 0 }, "2026-11").billed_amount_usd).toBe(0)
  })

  it("refuses the current or a future month, bad months and bad amounts", () => {
    const bad = [
      { ...ok, month: "2026-11" },
      { ...ok, month: "2026-12" },
      { ...ok, month: "2026-13" },
      { ...ok, month: "2026-9" },
      { ...ok, billed_amount_usd: -1 },
      { ...ok, billed_amount_usd: "" },
      { ...ok, billed_amount_usd: "abc" },
      { ...ok, credits_usd: -5 },
      { ...ok, provider_id: "" },
    ]
    for (const b of bad) expect(() => parseInvoiceOverrideInput(b, "2026-11")).toThrow(InvoiceInputError)
  })
})
