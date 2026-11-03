/**
 * Issue #35: a person / team / department filter lists the API keys it owns
 * (owner_person_id, team_id), $0 ones included, plus keys with spend in the
 * filtered rows. Display only, so totals and entity tables must not move.
 */

import { readFileSync } from "fs"
import { join } from "path"
import { computeBreakdown, type BreakdownData } from "./breakdown"
import { OK, PROVIDERS_WITH_GATEWAY, ownedKeysOrg, ownedKeysRows } from "./dashboard-fixtures"
import { D, K, PE, T } from "./test-fixtures"
import type { DashboardFilters } from "@/lib/dashboard-filters"

const NOW = new Date("2026-11-15T00:00:00Z")
const run = (filters: DashboardFilters = {}) =>
  computeBreakdown({ rows: ownedKeysRows(), org: ownedKeysOrg(), providers: PROVIDERS_WITH_GATEWAY, filters, params: { month: "2026-11" }, now: NOW })

/** [provider slug, group external id, key id, cost], in table order. */
const listed = (d: BreakdownData) =>
  d.key_groups.flatMap((pg) => pg.projects.flatMap((g) => g.keys.map((k) => [pg.provider_slug, g.external_id, k.id, k.cost])))
const ids = (d: BreakdownData) => listed(d).map((x) => x[2]).sort()

describe("API keys under a person filter (issue #35)", () => {
  const d = run({ person: PE.alice })

  it("lists every key the person owns, for every provider, plus keys they used", () => {
    expect(listed(d)).toEqual([
      ["openai", null, K.team, 40],
      ["vercel-ai-gateway", "prj_app", OK.gwZero, 0],
      ["vercel-ai-gateway", null, OK.gwUsedByAlice, 15],
      ["anthropic", "wrk_eng", OK.anOld, 0],
      ["anthropic", "wrk_eng", OK.anZero, 0],
    ])
  })

  it("lists a $0 Anthropic key and a $0 AI Gateway key in their workspace / project group", () => {
    const an = d.key_groups.find((g) => g.provider_slug === "anthropic")!.projects.find((g) => g.external_id === "wrk_eng")!
    expect(an).toMatchObject({ label: "Eng workspace", kind: "workspace" })
    expect(an.keys.find((k) => k.id === OK.anZero)).toMatchObject({ cost: 0, prevCost: 0, changePercent: null, owner: "Alice" })
    const gw = d.key_groups.find((g) => g.provider_slug === "vercel-ai-gateway")!.projects.find((g) => g.external_id === "prj_app")!
    expect(gw.label).toBe("App")
    expect(gw.keys.map((k) => [k.id, k.cost])).toEqual([[OK.gwZero, 0]])
  })

  it("lists an owned key whose only spend is outside the current and comparison periods, at $0", () => {
    const k = listed(d).find((x) => x[2] === OK.anOld)
    expect(k).toEqual(["anthropic", "wrk_eng", OK.anOld, 0])
  })

  it("lists someone else's key with spend from this person, and leaves out their other keys", () => {
    expect(listed(d).find((x) => x[2] === OK.gwUsedByAlice)?.[3]).toBe(15)
    for (const other of [OK.gwBob, OK.anBobZero, K.owner, K.bare, OK.anDataTeam]) expect(ids(d)).not.toContain(other)
  })

  it("the other owner sees their keys too, at $0 for spend that landed on someone else", () => {
    expect(listed(run({ person: PE.bob }))).toEqual([
      ["vercel-ai-gateway", null, OK.gwBob, 25],
      ["vercel-ai-gateway", null, OK.gwUsedByAlice, 0],
      ["anthropic", "wrk_eng", OK.anBobZero, 0],
      ["openai", null, K.owner, 0],
    ])
  })

  it("combines with the provider and project filters", () => {
    expect(ids(run({ person: PE.alice, provider: "anthropic" }))).toEqual([OK.anOld, OK.anZero].sort())
    expect(ids(run({ person: PE.alice, provider: "vercel-ai-gateway" }))).toEqual([OK.gwUsedByAlice, OK.gwZero].sort())
    // Bob's $0 key in the same workspace stays out.
    expect(ids(run({ person: PE.alice, project: "wrk_eng" }))).toEqual([OK.anOld, OK.anZero].sort())
    expect(ids(run({ person: PE.bob, project: "wrk_eng" }))).toEqual([OK.anBobZero])
  })

  it("an unassigned person filter keeps the spend-only rule", () => {
    expect(ids(run({ person: "unassigned" }))).toEqual([K.bare])
  })

  it("a key filter lists that key even at $0", () => {
    expect(listed(run({ key: K.owner }))).toEqual([["openai", null, K.owner, 0]])
  })

  it("no org filter still lists every registered key", () => {
    expect(ids(run())).toEqual(ownedKeysOrg().apiKeys.map((k) => k.id).sort())
  })
})

describe("API keys under team and department filters (issue #35)", () => {
  it("team: keys owned by its people, keys with its team_id, and keys with spend in the team's rows", () => {
    // Alice is on Platform. key_team (owner Alice, team Data) spends on Data, so $0 here.
    expect(listed(run({ team: T.platform }))).toEqual([
      ["vercel-ai-gateway", "prj_app", OK.gwZero, 0],
      ["vercel-ai-gateway", null, OK.gwUsedByAlice, 15],
      ["anthropic", "wrk_eng", OK.anOld, 0],
      ["anthropic", "wrk_eng", OK.anZero, 0],
      ["openai", null, K.team, 0],
    ])
    expect(listed(run({ team: T.data }))).toEqual([
      ["openai", null, K.team, 40],
      ["anthropic", null, OK.anDataTeam, 0],
    ])
  })

  it("department: the same rule through its teams", () => {
    expect(ids(run({ department: D.eng }))).toEqual([K.team, OK.anDataTeam, OK.anOld, OK.anZero, OK.gwUsedByAlice, OK.gwZero].sort())
    expect(ids(run({ department: D.sales }))).toEqual([K.owner, OK.anBobZero, OK.gwBob, OK.gwUsedByAlice].sort())
  })

  it("person + team needs the key to belong to both (or have spend in both)", () => {
    expect(listed(run({ person: PE.alice, team: T.data }))).toEqual([["openai", null, K.team, 40]])
  })
})

describe("totals unchanged (issue #35)", () => {
  // Captured from main before this change, for the same fixtures and filters.
  const baseline = JSON.parse(readFileSync(join(__dirname, "breakdown-totals-baseline.json"), "utf8")) as Record<
    "owned" | "base",
    Record<string, unknown>
  >
  const project = (d: BreakdownData) => ({
    total: d.total,
    department: d.department.map((e) => [e.key, e.cost, e.prevCost]),
    team: d.team.map((e) => [e.key, e.cost, e.prevCost]),
    person: d.person.map((e) => [e.key, e.cost, e.prevCost]),
    unassignedKey: d.api_key.filter((e) => e.unassigned).map((e) => [e.key, e.cost, e.prevCost]),
  })

  it.each(Object.keys(baseline.owned))("owned-key fixture, filters %s", (f) => {
    expect(project(run(JSON.parse(f)))).toEqual(baseline.owned[f])
  })

  it.each(Object.keys(baseline.base))("base fixture, filters %s", async (f) => {
    const { PROVIDERS, attributedRows } = await import("./dashboard-fixtures")
    const { orgData } = await import("./test-fixtures")
    const d = computeBreakdown({ rows: attributedRows(), org: orgData(), providers: PROVIDERS, filters: JSON.parse(f), params: { month: "2026-11" }, now: NOW })
    expect(project(d)).toEqual(baseline.base[f])
  })

  it.each([{}, { person: PE.alice }, { person: PE.bob }, { team: T.platform }, { department: D.sales }])(
    "listed key dollars equal the registered-key rows for %j ($0 keys add nothing)",
    (f) => {
      const d = run(f)
      const keyRows = d.api_key.filter((e) => !e.unassigned).reduce((s, e) => s + e.cost, 0)
      const groups = d.key_groups.reduce((s, g) => s + g.total_cost_usd, 0)
      expect(Math.round(groups * 100) / 100).toBe(Math.round(keyRows * 100) / 100)
    }
  )
})
