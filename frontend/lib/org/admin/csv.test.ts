/**
 * CSV team import parsing and matching (issue #43).
 */

import { dataRows, parseCsv, previewPeopleCsv, previewProjectsCsv, projectCandidates, resolveTeam, type CsvOrg } from "./csv"
import type { ProjectRow } from "./observed"
import { D, P, PE, PR, T, orgData } from "../test-fixtures"

function org(): CsvOrg {
  const o = orgData()
  return { departments: o.departments, teams: o.teams, people: o.people, identities: o.identities }
}

const project = (p: Partial<ProjectRow> & Pick<ProjectRow, "provider_id" | "external_project_id">): ProjectRow => ({
  kind: "project",
  name: null,
  id: null,
  team_id: null,
  observed: true,
  total_cost_usd: 0,
  record_count: 0,
  last_seen: null,
  ...p,
})

describe("parseCsv", () => {
  it("splits rows and cells, trims, and drops blank lines", () => {
    expect(parseCsv(" a , b \n\nc,d,e\n")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 3, cells: ["c", "d", "e"] },
    ])
  })

  it("handles CRLF, a BOM, quoted commas, escaped quotes and quoted newlines", () => {
    expect(parseCsv('﻿x,"Platform, Eng"\r\ny,"say ""hi"""\r\nz,"two\nlines"\r\nw,v')).toEqual([
      { line: 1, cells: ["x", "Platform, Eng"] },
      { line: 2, cells: ["y", 'say "hi"'] },
      { line: 3, cells: ["z", "two\nlines"] },
      { line: 5, cells: ["w", "v"] },
    ])
  })

  it("drops a header row only when its first cell is a column name", () => {
    expect(dataRows("Email,Team\na@x.com,Data", "people")).toEqual([{ line: 2, cells: ["a@x.com", "Data"] }])
    expect(dataRows("a@x.com,Data", "people")).toHaveLength(1)
    expect(dataRows("project,team\nproj_1,Data", "projects")).toEqual([{ line: 2, cells: ["proj_1", "Data"] }])
  })
})

describe("resolveTeam", () => {
  it("matches by name case-insensitively, scoped by department when given", () => {
    expect(resolveTeam(org(), "  platform ")).toEqual({
      ok: true,
      team: { id: T.platform, name: "Platform", department_id: D.eng, department_name: "Engineering" },
    })
    expect(resolveTeam(org(), "Data", "engineering")).toMatchObject({ ok: true, team: { id: T.data } })
  })

  it("an unknown name is a new team (in the given department); an unknown department is an error", () => {
    expect(resolveTeam(org(), "Ops")).toEqual({ ok: true, team: { id: null, name: "Ops", department_id: null, department_name: null } })
    expect(resolveTeam(org(), "Data", "Sales")).toEqual({ ok: true, team: { id: null, name: "Data", department_id: D.sales, department_name: "Sales" } })
    expect(resolveTeam(org(), "Data", "Marketing")).toEqual({ ok: false, message: 'Unknown department "Marketing"' })
  })

  it("a name shared by teams in two departments needs the department column", () => {
    const o = org()
    o.teams.push({ id: "team-data-2", name: "data", department_id: D.sales })
    expect(resolveTeam(o, "Data")).toEqual({ ok: false, message: 'More than one team is named "Data"; add a department column' })
    expect(resolveTeam(o, "Data", "Sales")).toMatchObject({ ok: true, team: { id: "team-data-2" } })
  })
})

describe("previewPeopleCsv", () => {
  const CSV = [
    "email,team,department",
    "Alice@Liatrio.com,Data", // change platform -> data
    "bob@liatrio.com,field", // unchanged
    "carol@liatrio.com,Platform,Engineering", // change none -> platform
    "nobody@liatrio.com,Data", // unmatched
    "not-an-email,Data", // invalid
    "dave@liatrio.com,", // invalid: no team
    "erin@liatrio.com,Ops", // unknown team
    "alice@liatrio.com,Field", // duplicate
    "dave.alias@liatrio.com,Field,Sales", // identity -> dave, change
    "erin@liatrio.com,Data,Marketing", // duplicate email, but listed as duplicate first
  ].join("\n")

  it("classifies every row and counts them", () => {
    const p = previewPeopleCsv(CSV, org())
    expect(p.rows.map((r) => [r.line, r.input, r.status])).toEqual([
      [2, "alice@liatrio.com", "change"],
      [3, "bob@liatrio.com", "unchanged"],
      [4, "carol@liatrio.com", "change"],
      [5, "nobody@liatrio.com", "unmatched"],
      [6, "not-an-email", "invalid"],
      [7, "dave@liatrio.com", "invalid"],
      [8, "erin@liatrio.com", "unknown_team"],
      [9, "alice@liatrio.com", "invalid"],
      [10, "dave.alias@liatrio.com", "change"],
      [11, "erin@liatrio.com", "invalid"],
    ])
    expect(p.counts).toEqual({ rows: 10, matched: 4, changes: 3, unchanged: 1, unmatched: 1, unknown_team: 1, invalid: 4 })
    expect(p.unknown_teams).toEqual([{ name: "Ops", department_id: null, department_name: null, rows: 1 }])
    expect(p.rows[0]).toMatchObject({ person_id: PE.alice, current_team_id: T.platform, team: { id: T.data } })
    expect(p.rows[8]).toMatchObject({ person_id: PE.dave, current_team_id: T.data, team: { id: T.field } })
    expect(p.rows[4].message).toBe('Invalid email "not-an-email"')
    expect(p.rows[7].message).toMatch(/more than once/)
  })

  it("with createTeams, rows on an unknown team become changes to a new team", () => {
    const p = previewPeopleCsv("erin@liatrio.com,Ops\ncarol@liatrio.com,ops", org(), { createTeams: true })
    expect(p.rows.map((r) => r.status)).toEqual(["change", "change"])
    expect(p.rows[0].team).toEqual({ id: null, name: "Ops", department_id: null, department_name: null })
    expect(p.unknown_teams).toEqual([{ name: "Ops", department_id: null, department_name: null, rows: 2 }])
    expect(p.counts.unknown_team).toBe(0)
  })

  it("an email and an alias of the same person: only the first row is used", () => {
    const p = previewPeopleCsv("dave@liatrio.com,Field\ndave.alias@liatrio.com,Platform", org())
    expect(p.rows.map((r) => [r.input, r.status])).toEqual([
      ["dave@liatrio.com", "change"],
      ["dave.alias@liatrio.com", "invalid"],
    ])
    expect(p.rows[1].message).toBe("Same person as line 1; only that row is used")
    expect(p.counts.changes).toBe(1)
  })

  it("an identity email shared by two people does not match", () => {
    const o = org()
    o.identities!.push({ person_id: PE.erin, external_id: "dave.alias@liatrio.com" })
    expect(previewPeopleCsv("dave.alias@liatrio.com,Data", o).rows[0].status).toBe("unmatched")
  })
})

describe("previewProjectsCsv", () => {
  const projects = projectCandidates(
    [
      project({ provider_id: P.openai, external_project_id: "proj_2", name: "Sales tools", id: PR.sales, team_id: T.field }),
      project({ provider_id: P.openai, external_project_id: "proj_9", name: "Experiments" }),
      project({ provider_id: P.anthropic, external_project_id: "wrk_1", kind: "workspace" }),
      project({ provider_id: P.openai, external_project_id: "proj_a", name: "Shared" }),
      project({ provider_id: P.anthropic, external_project_id: "proj_b", name: "shared" }),
    ],
    [{ id: "pr-reg", provider_id: P.openai, external_project_id: "proj_reg", name: "Registered only", team_id: null }]
  )

  it("matches by id, then by name; flags ambiguous names, workspaces and unknowns", () => {
    const p = previewProjectsCsv(
      [
        "project,team",
        "proj_2,Field", // unchanged by id
        "experiments,Data", // change by name, observed only
        "Registered only,Platform", // change, registered only
        "wrk_1,Data", // workspace
        "Shared,Data", // ambiguous
        "proj_404,Data", // unmatched
        "proj_9,Field", // duplicate
        "proj_2,", // invalid: no team
      ].join("\n"),
      org(),
      projects
    )
    expect(p.rows.map((r) => [r.input, r.status])).toEqual([
      ["proj_2", "unchanged"],
      ["experiments", "change"],
      ["Registered only", "change"],
      ["wrk_1", "invalid"],
      ["Shared", "invalid"],
      ["proj_404", "unmatched"],
      ["proj_9", "invalid"],
      ["proj_2", "invalid"],
    ])
    expect(p.rows[1]).toMatchObject({ provider_id: P.openai, external_project_id: "proj_9", project_id: null, project_name: "Experiments", team: { id: T.data } })
    expect(p.rows[2]).toMatchObject({ project_id: "pr-reg", current_team_id: null })
    expect(p.rows[3].message).toMatch(/workspace/)
    expect(p.rows[4].message).toMatch(/matches 2 projects/)
    expect(p.counts).toMatchObject({ rows: 8, matched: 3, changes: 2, unmatched: 1, invalid: 4 })
  })
})
