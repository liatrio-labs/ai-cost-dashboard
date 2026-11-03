/**
 * Keys under projects / workspaces (issue #28), fed through listKeys so the
 * admin path is covered end to end.
 */

import { listKeys, type ObservedRecord } from "./admin/observed"
import { groupKeys, keyProjectId } from "./key-groups"
import type { OrgApiKey, OrgProject } from "./types"

const OA = "prov-openai"
const AN = "prov-anthropic"
const GW = "prov-aigw"
const providers = [
  { id: OA, name: "openai", display_name: "OpenAI API" },
  { id: AN, name: "anthropic", display_name: "Anthropic API" },
  { id: GW, name: "vercel-ai-gateway", display_name: "Vercel AI Gateway" },
]

const rec = (provider_id: string, cost: number, attribution: Record<string, unknown>): ObservedRecord => ({
  provider_id,
  timestamp: "2026-11-01T00:00:00Z",
  cost_usd: cost,
  attribution: { granularity: "api_key", ...attribution },
})

const records: ObservedRecord[] = [
  rec(OA, 40, { api_key_id: "oa_a", api_key_name: "pipeline", project_id: "proj_data" }),
  rec(OA, 5, { api_key_id: "oa_b", project_id: "proj_data" }),
  rec(OA, 7, { api_key_id: "oa_c", project_id: "proj_web", project_name: "Web (from rows)" }),
  rec(AN, 30, { api_key_id: "an_a", workspace_id: "wrk_research" }),
  rec(AN, 3, { api_key_id: "an_default" }),
  rec(GW, 12, { api_key_id: "gw_scoped", project_id: "prj_site" }),
  rec(GW, 9, { api_key_id: "gw_shared" }),
]

const projects: OrgProject[] = [
  { id: "op-data", provider_id: OA, external_project_id: "proj_data", name: "Data", team_id: "team-data" },
  { id: "op-research", provider_id: AN, external_project_id: "wrk_research", name: "Research", team_id: null },
  { id: "op-site", provider_id: GW, external_project_id: "prj_site", name: "Marketing site", team_id: null },
  { id: "op-idle", provider_id: GW, external_project_id: "prj_idle", name: "Idle app", team_id: null },
]

const key = (id: string, provider_id: string, external_key_id: string, extra: Partial<OrgApiKey> = {}): OrgApiKey => ({
  id,
  provider_id,
  external_key_id,
  name: null,
  owner_person_id: null,
  team_id: null,
  ...extra,
})

const registered: OrgApiKey[] = [
  key("k1", OA, "oa_a"),
  // Gateway keys from Sync keys now with no spend yet: one project-scoped, one not.
  key("k2", GW, "gw_idle_scoped", { name: "idle scoped", org_project_id: "op-idle", assignment_source: "auto" }),
  key("k3", GW, "gw_idle", { name: "idle unscoped" }),
  // Registered OpenAI key with no spend and no known project.
  key("k4", OA, "oa_unused", { name: "unused" }),
]

function grouped() {
  return groupKeys(listKeys(records, registered), { providers, projects })
}
const provider = (id: string) => grouped().find((g) => g.provider_id === id)!
const labels = (id: string) =>
  Object.fromEntries(provider(id).projects.map((p) => [p.label, p.keys.map((k) => k.name || k.external_key_id)]))

describe("groupKeys", () => {
  it("puts OpenAI keys under their projects, named from org_projects or rows", () => {
    expect(provider(OA).noun).toBe("Project")
    expect(labels(OA)).toEqual({
      Data: ["pipeline", "oa_b"],
      proj_web: ["oa_c"],
      "No project": ["unused"],
    })
    const data = provider(OA).projects[0]
    expect(data).toMatchObject({ external_id: "proj_data", registered_id: "op-data", team_id: "team-data", total_cost_usd: 45 })
    // Unregistered project names can come from the rows.
    const withNames = groupKeys(listKeys(records, registered), {
      providers,
      projects,
      observedNames: new Map([[`${OA}:proj_web`, "Web (from rows)"]]),
    })
    expect(withNames.find((g) => g.provider_id === OA)!.projects.map((p) => p.label)).toContain("Web (from rows)")
  })

  it("puts Anthropic keys under workspaces, with the default workspace for none", () => {
    expect(provider(AN)).toMatchObject({ kind: "workspace", noun: "Workspace" })
    expect(labels(AN)).toEqual({ Research: ["an_a"], "Default workspace": ["an_default"] })
  })

  it("puts gateway keys under Vercel projects or No project, $0 registered keys included", () => {
    expect(provider(GW).noun).toBe("Vercel project")
    expect(labels(GW)).toEqual({
      "Marketing site": ["gw_scoped"],
      "Idle app": ["idle scoped"],
      "No project": ["gw_shared", "idle unscoped"],
    })
    const idle = provider(GW).projects.find((p) => p.label === "Idle app")!
    expect(idle.total_cost_usd).toBe(0)
    expect(idle.keys[0]).toMatchObject({ id: "k2", total_cost_usd: 0, observed: false })
  })

  it("keeps the 'none' group last and orders groups and providers by spend", () => {
    expect(grouped().map((g) => g.provider_id)).toEqual([OA, AN, GW])
    for (const g of grouped()) expect(g.projects.at(-1)!.external_id === null || g.projects.every((p) => p.external_id)).toBe(true)
  })

  it("a row project beats the key's assigned project; an assigned project from another provider is ignored", () => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    expect(keyProjectId({ provider_id: GW, external_key_id: "x", observed_project_id: "prj_site", org_project_id: "op-idle", total_cost_usd: 0 }, byId)).toBe("prj_site")
    expect(keyProjectId({ provider_id: GW, external_key_id: "x", org_project_id: "op-data", total_cost_usd: 0 }, byId)).toBeNull()
  })

  it("places a key by its most recent row, not by scan order (Bugbot)", () => {
    // Scan order is by row id: a re-pulled older row can come last.
    const rows: ObservedRecord[] = [
      { ...rec(OA, 5, { api_key_id: "oa_moved", project_id: "proj_data" }), timestamp: "2026-11-02T00:00:00Z" },
      { ...rec(OA, 50, { api_key_id: "oa_moved", project_id: "proj_web" }), timestamp: "2026-09-01T00:00:00Z" },
      { ...rec(AN, 1, { api_key_id: "an_moved", workspace_id: "wrk_new" }), timestamp: "2026-11-02T00:00:00Z" },
      { ...rec(AN, 9, { api_key_id: "an_moved", workspace_id: "wrk_old" }), timestamp: "2026-08-01T00:00:00Z" },
    ]
    const keys = listKeys(rows, [])
    expect(keys.find((k) => k.external_key_id === "oa_moved")?.observed_project_id).toBe("proj_data")
    expect(keys.find((k) => k.external_key_id === "an_moved")?.observed_workspace_id).toBe("wrk_new")
  })
})
