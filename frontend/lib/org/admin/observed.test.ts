import { buildOrgIndex } from "../attribution"
import { rollup, toAttributedDailyRows } from "../rollup"
import { P, PE, orgData } from "../test-fixtures"
import { buildUnassignedQueue, currentMonth, listKeys, monthRange, previewPeopleImport, unassignedGatewayKeys, type ObservedRecord } from "./observed"
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

describe("previewPeopleImport", () => {
  const r = (provider_id: string, cost_usd: number, attribution: Record<string, unknown>): ObservedRecord => ({
    provider_id,
    cost_usd,
    attribution: { granularity: "person", ...attribution },
  })

  it("never offers an email whose other records already resolve through an identity", () => {
    // dave.alias@ maps to dave on cursor (identity) but is unmatched on anthropic.
    // Importing it would create a people row whose email match beats the
    // identity and moves dave's cursor spend.
    const preview = previewPeopleImport(
      [
        r(P.cursor, 10, { person_email: "dave.alias@liatrio.com" }),
        r(P.anthropic, 3, { person_email: "dave.alias@liatrio.com" }),
        // bob's external id resolves on anthropic; the same email is unmatched on openai.
        r(P.anthropic, 1, { person_email: "bobby@other.com", person_external_id: "user_bob" }),
        r(P.openai, 2, { person_email: "bobby@other.com" }),
        r(P.openai, 4, { person_email: "new@liatrio.com" }),
      ],
      org
    )
    expect(preview.candidates.map((c) => c.email)).toEqual(["new@liatrio.com"])
    expect(preview.conflicts).toEqual([
      { email: "bobby@other.com", person_ids: [PE.bob], unmatched_cost_usd: 2 },
      { email: "dave.alias@liatrio.com", person_ids: [PE.dave], unmatched_cost_usd: 3 },
    ])
    expect(preview.already_known).toEqual([])
  })

  it("an email that is fully resolved is already known, not a conflict", () => {
    const preview = previewPeopleImport([r(P.cursor, 1, { person_email: "dave.alias@liatrio.com" })], org)
    expect(preview).toEqual({ candidates: [], already_known: ["dave.alias@liatrio.com"], conflicts: [] })
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

  it("listKeys adds 90-day spend, last spend date and provider_created_at (issue #45)", () => {
    const now = new Date("2026-11-15T00:00:00Z")
    const rows = listKeys(
      [
        { provider_id: "p", timestamp: "2026-11-01T00:00:00Z", cost_usd: 2, attribution: { api_key_id: "k_live", granularity: "api_key" } },
        { provider_id: "p", timestamp: "2026-05-01T00:00:00Z", cost_usd: 7, attribution: { api_key_id: "k_live", granularity: "api_key" } },
        { provider_id: "p", timestamp: "2026-06-01T00:00:00Z", cost_usd: 4, attribution: { api_key_id: "k_stale", granularity: "api_key" } },
        { provider_id: "p", timestamp: "2026-11-02T00:00:00Z", cost_usd: 0, attribution: { api_key_id: "k_stale", granularity: "api_key" } },
      ],
      [
        { id: "r1", provider_id: "p", external_key_id: "k_stale", owner_person_id: null, team_id: null, provider_created_at: "2025-01-01T00:00:00Z" },
        { id: "r2", provider_id: "p", external_key_id: "k_never", owner_person_id: null, team_id: null },
      ],
      now
    )
    const by = (id: string) => rows.find((r) => r.external_key_id === id)
    expect(by("k_live")).toMatchObject({ spend_90d: 2, last_spend: "2026-11-01", provider_created_at: null, total_cost_usd: 9 })
    expect(by("k_stale")).toMatchObject({ spend_90d: 0, last_spend: "2026-06-01", provider_created_at: "2025-01-01T00:00:00Z" })
    expect(by("k_never")).toMatchObject({ spend_90d: 0, last_spend: null, provider_created_at: null })
  })

  it("unassignedGatewayKeys: gateway keys with no owner, team or project (key or row)", () => {
    const rows = listKeys(
      [
        { provider_id: "gw", timestamp: "2026-11-01T00:00:00Z", cost_usd: 5, attribution: { api_key_id: "k_free", granularity: "api_key" } },
        { provider_id: "gw", timestamp: "2026-11-01T00:00:00Z", cost_usd: 2, attribution: { api_key_id: "k_scoped", project_id: "prj", granularity: "api_key" } },
        { provider_id: "gw", timestamp: "2026-11-01T00:00:00Z", cost_usd: 1, attribution: { api_key_id: "k_owned", granularity: "api_key" } },
        { provider_id: "openai", timestamp: "2026-11-01T00:00:00Z", cost_usd: 9, attribution: { api_key_id: "k_other", granularity: "api_key" } },
      ],
      [
        { id: "r1", provider_id: "gw", external_key_id: "k_owned", owner_person_id: "p", team_id: null, assignment_source: "auto" },
        { id: "r2", provider_id: "gw", external_key_id: "k_reg", owner_person_id: null, team_id: null, external_created_by_email: "a@x.com", spend_attribution: "team" },
      ]
    )
    const out = unassignedGatewayKeys(rows, "gw")
    expect(out.map((k) => k.external_key_id).sort()).toEqual(["k_free", "k_reg"])
    expect(out.find((k) => k.external_key_id === "k_reg")).toMatchObject({ external_created_by_email: "a@x.com", spend_attribution: "team", assignment_source: null })
    expect(rows.find((k) => k.external_key_id === "k_scoped")!.observed_project_id).toBe("prj")
    expect(unassignedGatewayKeys(rows, null)).toEqual([])
  })
})
