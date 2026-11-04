/**
 * Needs-review inbox (issue #44): fixture tests for every item kind, the
 * #39 projection for the current month and acknowledgement hiding.
 */

import { computeReviewInbox, isSpike, isSuppressed, reviewWindowStart, type ReviewDecision } from "./review-inbox"
import type { AttributedDailyRow, OrgData } from "./types"

const NOW = new Date("2026-11-15T12:00:00Z")
const AN = "prov-an"
const CU = "prov-cu"
const TEAM = "team-a"
const providers = [
  { id: AN, name: "anthropic", display_name: "Anthropic", last_collected_at: "2026-11-15T06:00:00Z" },
  { id: CU, name: "cursor", display_name: "Cursor", last_collected_at: "2026-11-15T06:00:00Z" },
]

const person = (id: string) => ({ id, email: `${id}@liatrio.com`, display_name: id, team_id: TEAM, active: true })
const org = (extra: Partial<OrgData> = {}): OrgData => ({
  departments: [],
  teams: [{ id: TEAM, name: "A", department_id: null }],
  people: ["p600", "p400", "pday", "p300", "pnew", "pnow", "pfloat"].map(person),
  identities: [],
  apiKeys: [],
  projects: [],
  ...extra,
})

const row = (date: string, cost: number, o: Partial<AttributedDailyRow> = {}): AttributedDailyRow => ({
  date,
  provider_id: AN,
  model_name: "m",
  person_id: null,
  org_api_key_id: null,
  team_id: TEAM,
  department_id: null,
  project_id: null,
  workspace_id: null,
  granularity: "person",
  total_cost_usd: cost,
  ...o,
})
/** `total` spread evenly over `days` consecutive days from `start`, below the person-day threshold. */
const spread = (personId: string, start: string, days: number, total: number, o: Partial<AttributedDailyRow> = {}) =>
  Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10)
    return row(d, total / days, { person_id: personId, ...o })
  })

function fixtureRows(): AttributedDailyRow[] {
  return [
    // 2.1x and $600 in October: a spike.
    ...spread("p600", "2026-09-05", 3, 600 / 2.1),
    ...spread("p600", "2026-10-05", 3, 600),
    // 2.1x but only $400: not a spike.
    ...spread("p400", "2026-09-05", 3, 400 / 2.1),
    ...spread("p400", "2026-10-05", 3, 400),
    // One $301 day (and enough October history that November isn't a spike).
    ...spread("pday", "2026-10-01", 20, 600),
    row("2026-11-03", 200, { person_id: "pday" }),
    row("2026-11-03", 101, { person_id: "pday", provider_id: CU }),
    // Exactly $300: not over.
    ...spread("p300", "2026-10-01", 20, 600),
    row("2026-11-04", 300, { person_id: "p300" }),
  ]
}

const inbox = (rows = fixtureRows(), o: Partial<OrgData> = {}, decisions: ReviewDecision[] = []) =>
  computeReviewInbox({ rows, org: org(o), providers, decisions, now: NOW })
const find = (box: ReturnType<typeof inbox>, kind: string, subject: string, period?: string) =>
  box.items.find((i) => i.kind === kind && i.subject === subject && (!period || i.period === period))

describe("person spikes", () => {
  test("a 2.1x / $600 person appears; a 2.1x / $400 person doesn't", () => {
    const box = inbox()
    expect(find(box, "person_spike", "p600", "2026-10")).toMatchObject({ amount: 600, previousAmount: 285.71, ratio: 2.1, projected: false, label: "p600" })
    expect(find(box, "person_spike", "p400")).toBeUndefined()
    expect(box.months).toEqual({ last: "2026-10", current: "2026-11" })
  })

  test("the rule: > 2x the previous month and > $500; no previous spend counts once over $500", () => {
    expect(isSpike(600, 285.71)).toBe(true)
    expect(isSpike(400, 190.48)).toBe(false)
    expect(isSpike(600, 300)).toBe(false) // exactly 2x
    expect(isSpike(500, 100)).toBe(false) // exactly $500
    expect(isSpike(501, 0)).toBe(true)
  })

  test("the current month uses the #39 projection and is labelled projected", () => {
    // October $300; November $40/day for the 14 complete days so far ($560).
    const rows = [...spread("pnow", "2026-10-01", 30, 300), ...spread("pnow", "2026-11-01", 14, 560)]
    const box = inbox(rows)
    const it = find(box, "person_spike", "pnow", "2026-11")
    expect(it).toMatchObject({ projected: true, previousAmount: 300 })
    // 30 days at $40 = $1,200 projected; 4x October.
    expect(it!.amount).toBeCloseTo(1200, 0)
    expect(it!.detail).toMatch(/actual so far \$560\.00/)
  })

  test("a projection that doesn't double doesn't appear", () => {
    const rows = [...spread("pnow", "2026-10-01", 30, 900), ...spread("pnow", "2026-11-01", 14, 560)]
    expect(find(inbox(rows), "person_spike", "pnow", "2026-11")).toBeUndefined()
  })
})

describe("person-days", () => {
  test("a $301 person-day appears (summed across providers); a $300 one doesn't", () => {
    const box = inbox()
    expect(find(box, "person_day", "pday", "2026-11-03")).toMatchObject({ amount: 301, detail: "Anthropic, Cursor" })
    expect(find(box, "person_day", "p300")).toBeUndefined()
    expect(box.items.filter((i) => i.kind === "person_day")).toHaveLength(1)
  })

  test("days before the last complete month are ignored", () => {
    expect(find(inbox([row("2026-09-20", 900, { person_id: "pday" })]), "person_day", "pday")).toBeUndefined()
  })
})

describe("newly unassigned spend", () => {
  const unassigned = (o: Partial<AttributedDailyRow>) => ({ team_id: null, ...o })

  test("groups first seen in the last 7 days appear with the existing assign target; older ones don't", () => {
    const rows = [
      row("2026-11-10", 5, unassigned({ person_id: "pnew" })),
      row("2026-11-12", 7, unassigned({ person_id: "pnew" })),
      row("2026-11-08", 50, unassigned({ person_id: "pfloat" })), // 7 days before today: not new
      row("2026-11-09", 2, unassigned({ person_id: "pfloat" })),
      row("2026-11-13", 3, unassigned({ org_api_key_id: "k1" })),
      row("2026-11-14", 4, unassigned({ project_id: "proj_9" })),
      row("2026-11-14", 1, unassigned({})),
      row("2026-10-01", 1, unassigned({ provider_id: CU })),
      row("2026-11-14", 9, unassigned({ provider_id: CU })), // provider-level, seen before
    ]
    const apiKeys = [{ id: "k1", provider_id: AN, external_key_id: "ext_k1", name: "CI key", owner_person_id: null, team_id: null }]
    const box = inbox(rows, { apiKeys })
    const kinds = box.items.filter((i) => i.kind === "unassigned_new")
    expect(kinds.map((i) => [i.subject, i.period, i.amount])).toEqual([
      ["person:pnew", "2026-11-10", 12],
      ["project:prov-an:proj_9", "2026-11-14", 4],
      ["api_key:k1", "2026-11-13", 3],
      ["provider:prov-an", "2026-11-14", 1],
    ])
    expect(find(box, "unassigned_new", "person:pnew")!.assign).toEqual({ kind: "person", email: "pnew@liatrio.com" })
    expect(find(box, "unassigned_new", "api_key:k1")!.assign).toEqual({ kind: "api_key", provider_id: AN, external_key_id: "ext_k1", name: "CI key" })
    expect(find(box, "unassigned_new", "project:prov-an:proj_9")!.assign).toEqual({ kind: "project", provider_id: AN, external_project_id: "proj_9" })
    expect(find(box, "unassigned_new", "provider:prov-an")!.assign).toBeNull()
  })
})

describe("newly active keys", () => {
  const key = (id: string, created: string | null | undefined) => ({
    id,
    provider_id: AN,
    external_key_id: `ext_${id}`,
    name: id,
    owner_person_id: "pnew",
    team_id: TEAM,
    provider_created_at: created,
  })

  test("only keys with a stored provider creation date in the last 7 days and spend since", () => {
    const rows = [
      row("2026-11-12", 20, { org_api_key_id: "fresh", person_id: "pnew" }),
      row("2026-11-12", 20, { org_api_key_id: "unknown", person_id: "pnew" }),
      row("2026-11-12", 20, { org_api_key_id: "old", person_id: "pnew" }),
    ]
    const apiKeys = [key("fresh", "2026-11-11T09:00:00+00:00"), key("unknown", null), key("noField", undefined), key("old", "2026-10-01T00:00:00Z"), key("idle", "2026-11-14T00:00:00Z")]
    const box = inbox(rows, { apiKeys })
    const keys = box.items.filter((i) => i.kind === "key_new")
    expect(keys.map((i) => [i.subject, i.period, i.amount])).toEqual([["fresh", "2026-11-11", 20]])
    expect(keys[0].detail).toBe("Anthropic · pnew · created 2026-11-11")
    // The key already has a team: nothing to assign.
    expect(keys[0].assign).toBeNull()
  })
})

describe("acknowledgements", () => {
  const ack = (amount: number, over: Partial<ReviewDecision> = {}): ReviewDecision => ({
    kind: "person_spike",
    subject: "p600",
    period: "2026-10",
    amount,
    status: "acknowledged",
    note: "conference",
    acknowledged_by: "admin@example.com",
    acknowledged_at: "2026-11-14T10:00:00Z",
    ...over,
  })

  test("an acknowledged item is hidden while its amount hasn't grown more than 25%", () => {
    const box = inbox(fixtureRows(), {}, [ack(600)])
    expect(find(box, "person_spike", "p600")).toBeUndefined()
    expect(box.hiddenCount).toBe(1)
    // Still hidden at exactly +25%.
    expect(find(inbox(fixtureRows(), {}, [ack(480)]), "person_spike", "p600")).toBeUndefined()
  })

  test("it comes back with the earlier decision once the amount grows past 25%", () => {
    const box = inbox(fixtureRows(), {}, [ack(479, { status: "assigned" })])
    expect(find(box, "person_spike", "p600")).toMatchObject({ previous: { amount: 479, note: "conference", status: "assigned" } })
    expect(box.hiddenCount).toBe(0)
  })

  test("a decision for another period doesn't hide the item", () => {
    expect(find(inbox(fixtureRows(), {}, [ack(600, { period: "2026-09" })]), "person_spike", "p600")).toBeDefined()
  })

  test("isSuppressed", () => {
    expect(isSuppressed(125, { amount: 100 })).toBe(true)
    expect(isSuppressed(125.01, { amount: "100.00" })).toBe(false)
    expect(isSuppressed(1, undefined)).toBe(false)
  })
})

test("window starts on the 1st of the month before the last complete month", () => {
  expect(reviewWindowStart(NOW)).toBe("2026-09-01")
  expect(reviewWindowStart(new Date("2026-01-03T00:00:00Z"))).toBe("2025-11-01")
})
