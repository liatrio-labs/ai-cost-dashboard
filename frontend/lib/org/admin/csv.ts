/**
 * CSV team import for /admin/org (issue #43). Pure: parse the pasted or
 * uploaded CSV, match each row against the org, and say what an apply would
 * change. The import route runs this for the dry run and again for the
 * apply, so the two always agree.
 *
 *   people:   email,team[,department]
 *   projects: project,team
 *
 * A header row is optional (detected by its first cell: "email" or
 * "project"). Teams match by name, case-insensitively. The department column
 * picks between teams that share a name and is the department a new team is
 * created in; an unknown department makes the row invalid (departments are
 * never created here). A team name that matches nothing is an unknown team:
 * listed, and created on apply only when create_teams is set. A project
 * matches its external id, else its name (registered or observed). Anthropic
 * workspaces are skipped: their teams don't feed the rollup.
 */

import { z } from "zod"
import { normalizeEmail } from "../attribution"
import type { Department, OrgProject, Person, PersonIdentity, Team } from "../types"
import type { ProjectRow } from "./observed"

export type CsvKind = "people" | "projects"

/** Rows beyond this are rejected (the org has a couple of hundred people). */
export const MAX_CSV_ROWS = 5000

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * RFC 4180-ish: comma separated, double-quoted fields may hold commas, quotes
 * ("") and newlines. Cells are trimmed; blank lines are dropped. Returns each
 * row's cells with its 1-based line number.
 */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let cell = ""
  let quoted = false
  let line = 1
  let rowLine = 1
  const src = text.replace(/^﻿/, "")

  const endRow = () => {
    cells.push(cell)
    if (cells.some((c) => c.trim() !== "")) out.push({ line: rowLine, cells: cells.map((c) => c.trim()) })
    cells = []
    cell = ""
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        if (ch === "\n") line++
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell.trim() === "") {
      cell = ""
      quoted = true
    } else if (ch === ",") {
      cells.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++
      endRow()
      line++
      rowLine = line
    } else {
      cell += ch
    }
  }
  endRow()
  return out
}

const HEADER_FIRST_CELL: Record<CsvKind, string[]> = {
  people: ["email", "person", "person_email"],
  projects: ["project", "project_id", "external_project_id", "name"],
}

/** Data rows only: drops a header row when the first row's first cell is a column name. */
export function dataRows(text: string, kind: CsvKind): { line: number; cells: string[] }[] {
  const rows = parseCsv(text)
  if (rows.length && HEADER_FIRST_CELL[kind].includes(rows[0].cells[0].toLowerCase())) rows.shift()
  return rows
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export type RowStatus =
  /** Matched, and applying moves it to a different team. */
  | "change"
  /** Matched, already on that team. */
  | "unchanged"
  /** No person / project for this row: nothing is written for it. */
  | "unmatched"
  /** The team doesn't exist and create_teams is off: nothing is written for it. */
  | "unknown_team"
  /** Malformed row (bad email, no team, ambiguous team or project, duplicate, workspace). */
  | "invalid"

export interface TeamRef {
  /** Existing team id, or null when the team is new (created on apply). */
  id: string | null
  name: string
  department_id: string | null
  department_name: string | null
}

export interface CsvRowResult {
  line: number
  /** The row's key: the email or the project cell. */
  input: string
  status: RowStatus
  message?: string
  team: TeamRef | null
  /** people */
  person_id?: string
  /** projects */
  provider_id?: string
  external_project_id?: string
  /** registered org_projects id; null = observed only (registered on apply) */
  project_id?: string | null
  project_name?: string | null
  /** The team the row is on now. */
  current_team_id?: string | null
}

export interface UnknownTeam {
  name: string
  department_id: string | null
  department_name: string | null
  rows: number
}

export interface CsvPreview {
  kind: CsvKind
  counts: {
    rows: number
    matched: number
    changes: number
    unchanged: number
    unmatched: number
    unknown_team: number
    invalid: number
  }
  rows: CsvRowResult[]
  unknown_teams: UnknownTeam[]
}

export interface CsvOrg {
  departments: Pick<Department, "id" | "name">[]
  teams: Pick<Team, "id" | "name" | "department_id">[]
  people?: Pick<Person, "id" | "email" | "team_id">[]
  identities?: Pick<PersonIdentity, "person_id" | "external_id">[]
}

const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase()
const teamKey = (name: string, departmentId: string | null) => `${departmentId ?? ""}\u0000${fold(name)}`

type TeamResolution = { ok: true; team: TeamRef } | { ok: false; message: string }

/** Find the team named in a row (see the module comment for the rules). */
export function resolveTeam(org: CsvOrg, name: string, departmentName?: string | null): TeamResolution {
  const deptCell = departmentName?.trim() || null
  let dept: Pick<Department, "id" | "name"> | null = null
  if (deptCell) {
    dept = org.departments.find((d) => fold(d.name) === fold(deptCell)) ?? null
    if (!dept) return { ok: false, message: `Unknown department "${deptCell}"` }
  }
  const named = org.teams.filter((t) => fold(t.name) === fold(name))
  const candidates = dept ? named.filter((t) => (t.department_id ?? null) === dept!.id) : named
  if (candidates.length > 1) {
    return { ok: false, message: `More than one team is named "${name}"; add a department column` }
  }
  const t = candidates[0]
  if (t) {
    const d = org.departments.find((x) => x.id === t.department_id)
    return { ok: true, team: { id: t.id, name: t.name, department_id: t.department_id ?? null, department_name: d?.name ?? null } }
  }
  return { ok: true, team: { id: null, name: name.trim().replace(/\s+/g, " "), department_id: dept?.id ?? null, department_name: dept?.name ?? null } }
}

function finish(kind: CsvKind, rows: CsvRowResult[]): CsvPreview {
  const unknown = new Map<string, UnknownTeam>()
  for (const r of rows) {
    if (!r.team || r.team.id || (r.status !== "change" && r.status !== "unknown_team")) continue
    const k = teamKey(r.team.name, r.team.department_id)
    const u = unknown.get(k) ?? { name: r.team.name, department_id: r.team.department_id, department_name: r.team.department_name, rows: 0 }
    u.rows += 1
    unknown.set(k, u)
  }
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length
  return {
    kind,
    counts: {
      rows: rows.length,
      matched: count("change") + count("unchanged"),
      changes: count("change"),
      unchanged: count("unchanged"),
      unmatched: count("unmatched"),
      unknown_team: count("unknown_team"),
      invalid: count("invalid"),
    },
    rows,
    unknown_teams: [...unknown.values()],
  }
}

/** The status of a matched row, given its team. */
function matchedStatus(team: TeamRef, currentTeamId: string | null, createTeams: boolean): RowStatus {
  if (!team.id) return createTeams ? "change" : "unknown_team"
  return team.id === currentTeamId ? "unchanged" : "change"
}

const isEmail = (s: string) => z.email().safeParse(s).success

/** people: email,team[,department]. Matches people.email, else an identity whose external id is that email. */
export function previewPeopleCsv(text: string, org: CsvOrg, opts: { createTeams?: boolean } = {}): CsvPreview {
  const people = org.people ?? []
  const byEmail = new Map(people.map((p) => [normalizeEmail(p.email), p]))
  const byIdentity = new Map<string, Set<string>>()
  for (const i of org.identities ?? []) {
    const e = normalizeEmail(i.external_id)
    if (!e) continue
    const s = byIdentity.get(e) ?? new Set<string>()
    s.add(i.person_id)
    byIdentity.set(e, s)
  }
  const seen = new Set<string>()
  /** person id -> first line that matched them (an email and an alias of the same person). */
  const personLine = new Map<string, number>()
  const out: CsvRowResult[] = []

  for (const { line, cells } of dataRows(text, "people")) {
    const [emailCell = "", teamCell = "", deptCell = ""] = cells
    const email = normalizeEmail(emailCell) ?? ""
    const base = { line, input: emailCell, team: null }
    if (!email || !isEmail(email)) {
      out.push({ ...base, status: "invalid", message: emailCell ? `Invalid email "${emailCell}"` : "Email is required" })
      continue
    }
    if (!teamCell) {
      out.push({ ...base, input: email, status: "invalid", message: "Team is required" })
      continue
    }
    if (seen.has(email)) {
      out.push({ ...base, input: email, status: "invalid", message: "Email appears more than once; only its first row is used" })
      continue
    }
    seen.add(email)
    const resolved = resolveTeam(org, teamCell, deptCell)
    if (!resolved.ok) {
      out.push({ ...base, input: email, status: "invalid", message: resolved.message })
      continue
    }
    let person = byEmail.get(email)
    if (!person) {
      const ids = byIdentity.get(email)
      if (ids?.size === 1) person = people.find((p) => p.id === [...ids][0])
    }
    if (!person) {
      out.push({ line, input: email, status: "unmatched", message: "No person with this email", team: resolved.team })
      continue
    }
    const first = personLine.get(person.id)
    if (first !== undefined) {
      out.push({ ...base, input: email, status: "invalid", message: `Same person as line ${first}; only that row is used` })
      continue
    }
    personLine.set(person.id, line)
    out.push({
      line,
      input: email,
      status: matchedStatus(resolved.team, person.team_id ?? null, !!opts.createTeams),
      team: resolved.team,
      person_id: person.id,
      current_team_id: person.team_id ?? null,
    })
  }
  return finish("people", out)
}

/**
 * Every project the import can match: registered org_projects plus projects
 * observed in cost records (the GET /projects list), de-duplicated.
 */
export function projectCandidates(observed: ProjectRow[], registered: OrgProject[]): ProjectRow[] {
  const key = (p: { provider_id: string; external_project_id: string }) => `${p.provider_id}\u0000${p.external_project_id}`
  const rows = new Map(observed.map((p) => [key(p), p]))
  for (const p of registered) {
    if (rows.has(key(p))) continue
    rows.set(key(p), {
      provider_id: p.provider_id,
      external_project_id: p.external_project_id,
      kind: "project",
      name: p.name ?? null,
      id: p.id,
      team_id: p.team_id ?? null,
      observed: false,
      total_cost_usd: 0,
      record_count: 0,
      last_seen: null,
    })
  }
  return [...rows.values()]
}

/** projects: project,team. The project cell is an external id or a name. */
export function previewProjectsCsv(text: string, org: CsvOrg, projects: ProjectRow[], opts: { createTeams?: boolean } = {}): CsvPreview {
  const seen = new Set<string>()
  const out: CsvRowResult[] = []

  for (const { line, cells } of dataRows(text, "projects")) {
    const [projectCell = "", teamCell = ""] = cells
    const base = { line, input: projectCell, team: null }
    if (!projectCell) {
      out.push({ ...base, status: "invalid", message: "Project is required" })
      continue
    }
    if (!teamCell) {
      out.push({ ...base, status: "invalid", message: "Team is required" })
      continue
    }
    const resolved = resolveTeam(org, teamCell)
    if (!resolved.ok) {
      out.push({ ...base, status: "invalid", message: resolved.message })
      continue
    }
    let matches = projects.filter((p) => p.external_project_id === projectCell)
    if (!matches.length) matches = projects.filter((p) => p.name && fold(p.name) === fold(projectCell))
    if (!matches.length) {
      out.push({ line, input: projectCell, status: "unmatched", message: "No project with this id or name", team: resolved.team })
      continue
    }
    if (matches.length > 1) {
      out.push({ ...base, status: "invalid", message: `"${projectCell}" matches ${matches.length} projects; use the project id` })
      continue
    }
    const p = matches[0]
    const ref = { provider_id: p.provider_id, external_project_id: p.external_project_id, project_id: p.id, project_name: p.name, current_team_id: p.team_id }
    if (p.kind === "workspace") {
      out.push({ ...base, ...ref, status: "invalid", message: "Anthropic workspace: its team doesn't feed the rollup" })
      continue
    }
    const k = `${p.provider_id}\u0000${p.external_project_id}`
    if (seen.has(k)) {
      out.push({ ...base, ...ref, status: "invalid", message: "Project appears more than once; only its first row is used" })
      continue
    }
    seen.add(k)
    out.push({ line, input: projectCell, ...ref, status: matchedStatus(resolved.team, p.team_id, !!opts.createTeams), team: resolved.team })
  }
  return finish("projects", out)
}

/** Key for grouping rows by the (possibly new) team they move to. */
export function targetTeamKey(team: TeamRef): string {
  return team.id ?? `new:${teamKey(team.name, team.department_id)}`
}
