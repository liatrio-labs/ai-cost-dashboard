/**
 * Issue #88: Nov 6 live-review accuracy fixes, at the data layer.
 */

import { computeDashboard, type ProviderRow } from "@/lib/dashboard-compute"
import { FORECAST_DEFAULTS } from "@/lib/forecast-settings"
import {
  cursorSeatComposition,
  isLicenseRow,
  licenseKind,
  userFacingDescription,
  userFacingProviderName,
} from "@/lib/cost-types"
import { ratesAt } from "@/lib/cursor-seats"
import {
  formatDayLabel,
  formatPeriodLabel,
  isLowConfidence,
  projectedChangeLabel,
  projectedPercentText,
  LOW_CONFIDENCE_DAYS,
} from "@/lib/dashboard-types"
import { donutTotal } from "@/components/spend-breakdown-chart"
import { manualEntryMonthOptions } from "@/components/monthly-entry-form"
import { computeBreakdown } from "@/lib/org/breakdown"
import { PROVIDERS, attributedRows } from "@/lib/org/dashboard-fixtures"
import { orgData } from "@/lib/org/test-fixtures"
import { peopleNeedingReview } from "@/lib/org/person-hygiene"

import { PROV, RATES, novRows, row } from "@/lib/issue88-fixtures"

const NOW = new Date("2026-11-06T15:00:00Z")

const dashboard = () =>
  computeDashboard({
    daily: novRows(),
    providers: PROV,
    params: { month: "2026-11" },
    forecastSettings: FORECAST_DEFAULTS,
    now: NOW,
    cursorSeatRates: RATES,
  })

describe("seats excluded from the model chart and shown as labeled licenses (#88 AC1)", () => {
  it("byModel holds only real models; seats move to byLicense as Claude Ultra seats and Cursor seats", () => {
    const d = dashboard()
    expect(d.byModel.map((m) => m.model)).toEqual(["claude-opus-5-5", "grok-bot-default"])
    expect(d.byModel.some((m) => /seats/.test(m.model))).toBe(false)
    expect(d.byLicense.map((l) => [l.label, l.total])).toEqual([
      ["Claude Ultra seats", 7600],
      ["Cursor seats", 240],
    ])
    // Nothing is lost: models + licenses = headline.
    const sum = d.byModel.reduce((s, m) => s + m.total, 0) + d.byLicense.reduce((s, l) => s + l.total, 0)
    expect(sum).toBeCloseTo(d.kpis.totalSpend, 2)
  })

  it("classifies bill rows, not usage, as licenses", () => {
    expect(licenseKind("seats", "claude-max")).toBe("seats")
    expect(licenseKind("cursor seats", "cursor")).toBe("seats")
    expect(licenseKind("chatgpt-business", "chatgpt")).toBe("seats")
    expect(licenseKind("recurring", "lovable")).toBe("subscription")
    expect(licenseKind("manual", "lovable")).toBe("subscription")
    expect(licenseKind("invoice adjustment", "cursor")).toBe("invoice_adjustment")
    expect(isLicenseRow("grok-bot-default", "cursor")).toBe(false)
    expect(isLicenseRow("claude-opus-5-5", "anthropic")).toBe(false)
  })
})

describe("Cursor cost types and seat composition (#88 AC2, AC4)", () => {
  it("splits the Cursor total into seats and calendar on-demand, summing to the row", () => {
    const cursor = dashboard().tools.find((t) => t.id === "pv-cursor")!
    expect(cursor.monthlySpend).toBe(340)
    expect(cursor.cursorCostTypes).toMatchObject({ seats: 240, calendarOnDemand: 100 })
    expect(cursor.cursorCostTypes!.seats + cursor.cursorCostTypes!.calendarOnDemand).toBe(cursor.monthlySpend)
  })

  it("describes seats from stored assignments and rates, not a flat $40 x N", () => {
    const comp = dashboard().tools.find((t) => t.id === "pv-cursor")!.cursorCostTypes!.seatComposition!
    expect(comp.text).toBe("3 Standard × $40.00 + 2 Premium × $60.00 = $240.00; Free seats bill $0")
    expect(comp.parts.map((p) => [p.type, p.count, p.rate])).toEqual([
      ["standard", 3, 40],
      ["premium", 2, 60],
    ])
  })

  it("an amount matching no stored rate (an invoice-scaled month) is called other, not guessed", () => {
    const comp = cursorSeatComposition([{ date: "2026-11-01", total_cost_usd: 37.5 }], (ym) => ratesAt(RATES, ym))!
    expect(comp.text).toMatch(/^1 other seat × \$37\.50 = \$37\.50/)
  })

  it("no seat rows: no cost-type split claims seats", () => {
    const d = computeDashboard({
      daily: [row("2026-11-03", "pv-cursor", "grok-bot-default", 100)],
      providers: PROV,
      params: { month: "2026-11" },
      forecastSettings: FORECAST_DEFAULTS,
      now: NOW,
    })
    expect(d.tools[0].cursorCostTypes).toMatchObject({ seats: 0, calendarOnDemand: 100, seatComposition: null })
  })
})

describe("Claude Ultra naming (#88 AC6)", () => {
  it("shows claude-max as Claude Ultra and rewrites Claude Max in its description; slug unchanged", () => {
    const t = dashboard().tools.find((x) => x.id === "pv-claude-max")!
    expect(t.name).toBe("Claude Ultra")
    expect(t.description).toBe("Claude Ultra seats on personal cards")
    expect(userFacingProviderName("claude-max", "Claude Ultra")).toBe("Claude Ultra")
    expect(userFacingProviderName("claude-max", null)).toBe("Claude Ultra")
    expect(userFacingProviderName("anthropic", "Anthropic (Claude API)")).toBe("Anthropic (Claude API)")
    expect(userFacingDescription("anthropic", "Claude Max mention elsewhere")).toBe("Claude Max mention elsewhere")
  })
})

describe("matching headline/donut rounding (#88 AC9)", () => {
  it("the donut shows the headline even when per-provider rounded amounts sum a cent off", () => {
    const daily = [
      row("2026-11-02", "pv-anthropic", "a", 10.005),
      row("2026-11-02", "pv-cursor", "b", 10.005),
      row("2026-11-02", "pv-claude-max", "seats", 8068.92),
    ]
    const d = computeDashboard({ daily, providers: PROV, params: { month: "2026-11" }, forecastSettings: FORECAST_DEFAULTS, now: NOW })
    const sliceSum = Math.round(d.tools.reduce((s, t) => s + t.monthlySpend, 0) * 100) / 100
    expect(sliceSum).not.toBe(d.kpis.totalSpend) // the review's drift: $28,088.94 vs $28,088.93
    expect(donutTotal(d.tools, d.kpis.totalSpend)).toBe(d.kpis.totalSpend)
  })
})

describe("projection low-confidence / capping (#88 AC8)", () => {
  it("fewer than 10 complete days is low confidence and big changes are capped; actual numbers untouched", () => {
    expect(LOW_CONFIDENCE_DAYS).toBe(10)
    expect(isLowConfidence({ completeDays: 5 })).toBe(true)
    expect(isLowConfidence({ completeDays: 10 })).toBe(false)
    expect(projectedChangeLabel(206, { completeDays: 5 })).toBe(">+100% projected")
    expect(projectedChangeLabel(1230.8, { completeDays: 5 })).toBe(">+100% projected")
    expect(projectedChangeLabel(-40, { completeDays: 5 })).toBe("-40% projected")
    expect(projectedChangeLabel(206, { completeDays: 12 })).toBe("+206% projected")
    expect(projectedPercentText(80, { completeDays: 2 })).toBe("+80%")
    // Without a basis (legacy callers) nothing is capped.
    expect(projectedChangeLabel(206)).toBe("+206% projected")
  })

  it("the dashboard's projection basis is days elapsed in the month", () => {
    const d = dashboard()
    expect(d.projection.basis!.completeDays).toBeLessThan(LOW_CONFIDENCE_DAYS)
    expect(isLowConfidence(d.projection.basis)).toBe(true)
  })
})

describe("Lovable include/exclude note matches totals (#88 AC5)", () => {
  it("org-level-only spend is in the Unassigned department, departments sum to the headline, and other rows say so", () => {
    const providers: ProviderRow[] = [...PROVIDERS, { id: "pv-lovable", name: "lovable", display_name: "Lovable", metadata: { collection_method: "manual" } }]
    const org = orgData()
    const rows = [
      ...attributedRows(org),
      {
        date: "2026-11-01",
        provider_id: "pv-lovable",
        model_name: "manual",
        total_cost_usd: 400,
        total_tokens: 0,
        total_requests: 0,
        record_count: 1,
        granularity: "org",
        person_id: null,
        team_id: null,
        department_id: null,
        org_api_key_id: null,
        project_id: null,
      },
    ] as unknown as ReturnType<typeof attributedRows>
    const b = computeBreakdown({ rows, org, providers, filters: {}, params: { month: "2026-11" }, now: new Date("2026-11-15T00:00:00Z") })
    const sum = b.department.reduce((s, d) => s + d.cost, 0)
    expect(sum).toBeCloseTo(b.total.cost, 2)
    expect(b.total.cost).toBe(650) // 250 fixture spend + Lovable 400: the headline includes Lovable
    const un = b.department.find((d) => d.unassigned)!
    expect(un.byProvider.lovable).toBe(400)
    expect(un.coverage.map((c) => c.providerName)).toContain("Lovable")
    // Assigned rows note Lovable as a gap, which the UI words as "Counted in Unassigned, not this row".
    const eng = b.department.find((d) => !d.unassigned && !d.automation)!
    expect(eng.coverage.map((c) => c.providerName)).toContain("Lovable")
    expect(eng.byProvider.lovable ?? 0).toBe(0)
  })
})

describe("readable dates (#88 AC10)", () => {
  it("formats whole months by name and other ranges as dates", () => {
    expect(formatPeriodLabel("2026-10-01", "2026-10-31")).toBe("October 2026")
    expect(formatPeriodLabel("2026-10-05", "2026-11-03")).toMatch(/^Oct 5 – Nov 3, 2026$/)
    expect(formatDayLabel("2026-10-01")).toBe("Oct 1, 2026")
  })

  it("manual-entry months: current month first, each once, no next month", () => {
    const opts = manualEntryMonthOptions(new Date("2026-11-06T12:00:00Z"))
    expect(opts[0]).toEqual({ value: "2026-11", label: "November 2026" })
    expect(opts.at(-1)!.value).toBe("2025-12")
    expect(new Set(opts.map((o) => o.value)).size).toBe(opts.length)
    expect(new Set(opts.map((o) => o.label.split(" ")[0])).size).toBe(opts.length) // no repeated month name
    expect(opts.some((o) => o.value > "2026-11")).toBe(false)
  })
})

describe("people data hygiene (#88 AC15)", () => {
  it("flags placeholder, duplicate, slug, email and first-name-only names without merging", () => {
    const people = [
      { id: "1", email: "a@liatrio.com", display_name: "Deleted User" },
      { id: "2", email: "b@liatrio.com", display_name: "Deleted User" },
      { id: "3", email: "ali.hassanein@liatrio.com", display_name: "ali-hassanein" },
      { id: "4", email: "olivere@liatrio.com", display_name: null },
      { id: "5", email: "matt@liatrio.com", display_name: "Matt" },
      { id: "6", email: "jane.doe@liatrio.com", display_name: "Jane Doe" },
      { id: "7", email: "gone@liatrio.com", display_name: "Deleted User", active: false },
    ]
    const flags = peopleNeedingReview(people)
    const byId = Object.fromEntries(flags.map((f) => [f.person.id, f.reasons]))
    expect(byId["1"]).toEqual(["placeholder_name", "duplicate_name"])
    expect(byId["2"]).toEqual(["placeholder_name", "duplicate_name"])
    expect(byId["3"]).toEqual(["slug_name"])
    expect(byId["4"]).toEqual(["email_as_name"])
    expect(byId["5"]).toEqual(["first_name_only"])
    expect(byId["6"]).toBeUndefined()
    expect(byId["7"]).toBeUndefined() // inactive skipped
    expect(people).toHaveLength(7) // input untouched
  })
})
