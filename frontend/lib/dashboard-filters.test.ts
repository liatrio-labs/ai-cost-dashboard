import { effectiveProjectId, matchesFilters } from "./dashboard-filters"
import { narrowAttributed, type Query } from "./dashboard-data"

const row = (extra: Record<string, string | null> = {}) => ({
  provider_id: "prov-anthropic",
  department_id: null,
  team_id: null,
  person_id: null,
  org_api_key_id: null,
  project_id: null,
  workspace_id: null,
  ...extra,
})

describe("project filter and workspaces (issue #28)", () => {
  it("a workspace stands in for a missing project", () => {
    expect(effectiveProjectId(row({ workspace_id: "wrk_1" }))).toBe("wrk_1")
    expect(effectiveProjectId(row({ project_id: "proj_1", workspace_id: "wrk_1" }))).toBe("proj_1")
    expect(effectiveProjectId(row())).toBeNull()
  })

  it("matches workspace rows by id, and excludes them from Unassigned", () => {
    expect(matchesFilters(row({ workspace_id: "wrk_1" }), { project: "wrk_1" })).toBe(true)
    expect(matchesFilters(row({ workspace_id: "wrk_1" }), { project: "unassigned" })).toBe(false)
    expect(matchesFilters(row(), { project: "unassigned" })).toBe(true)
    expect(matchesFilters(row({ project_id: "proj_1" }), { project: "wrk_1" })).toBe(false)
  })

  it("pushes down only a superset for project filters", () => {
    const calls: string[] = []
    const q: Query = {
      eq: (c, v) => (calls.push(`eq ${c}=${v}`), q),
      is: (c) => (calls.push(`is ${c}`), q),
      order: () => q,
      range: () => q,
      gte: () => q,
      lt: () => q,
      then: undefined as never,
    }
    narrowAttributed({ project: "wrk_1", team: "t1" }, null)(q)
    expect(calls).toEqual(["eq team_id=t1"])
    calls.length = 0
    narrowAttributed({ project: "unassigned" }, null)(q)
    expect(calls).toEqual(["is project_id"])
  })
})
