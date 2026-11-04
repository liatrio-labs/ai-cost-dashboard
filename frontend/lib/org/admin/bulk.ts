/**
 * Bulk team assignment writes (issue #43): the multi-select "Assign team"
 * actions and the CSV import apply.
 *
 * PostgREST has no multi-statement transactions, so a batch is
 * transaction-like instead: every row is validated before anything is
 * written, rows are written with as few statements as possible (one UPDATE
 * ... WHERE id IN (...) per target team, one INSERT for new rows), and if a
 * later statement fails the earlier ones are undone (team_ids restored,
 * inserted rows deleted) before the error is returned.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { DbError, must } from "./http"
import { targetTeamKey, type CsvPreview, type CsvRowResult, type UnknownTeam } from "./csv"
import type { OrgSnapshot } from "./schemas"

type Table = "people" | "org_projects"

export type BulkRowStatus = "updated" | "created" | "unchanged" | "skipped"

export interface BulkRowResult {
  /** people: person id; projects: provider_id:external_project_id */
  key: string
  status: BulkRowStatus
  team_id: string | null
  previous_team_id: string | null
  message?: string
}

interface Move {
  id: string
  from: string | null
  to: string | null
}

/** Undo log for one batch, run in reverse on failure. */
class Batch {
  private undo: (() => Promise<void>)[] = []
  constructor(private admin: SupabaseClient) {}

  /** UPDATE <table> SET team_id per target team; restorable. */
  async moveTeams(table: Table, moves: Move[]) {
    const byTarget = groupBy(moves, (m) => m.to ?? "")
    for (const [to, group] of byTarget) {
      const ids = group.map((m) => m.id)
      must(await this.admin.from(table).update({ team_id: to || null }).in("id", ids).select("id"))
      this.undo.push(async () => {
        for (const [from, back] of groupBy(group, (m) => m.from ?? "")) {
          await this.admin.from(table).update({ team_id: from || null }).in("id", back.map((m) => m.id))
        }
      })
    }
  }

  /** INSERT rows; deleted again on failure. */
  async insert<T extends { id: string }>(table: "teams" | "org_projects", rows: Record<string, unknown>[], select: string): Promise<T[]> {
    if (!rows.length) return []
    const created = (must(await this.admin.from(table).insert(rows).select(select)) ?? []) as unknown as T[]
    this.undo.push(async () => {
      await this.admin.from(table).delete().in("id", created.map((r) => r.id))
    })
    return created
  }

  async rollback() {
    for (const fn of this.undo.reverse()) {
      try {
        await fn()
      } catch (e) {
        console.error("bulk team assignment rollback step failed:", e instanceof Error ? e.message : e)
      }
    }
    this.undo = []
  }
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const list = out.get(k) ?? []
    list.push(r)
    out.set(k, list)
  }
  return out
}

async function inBatch<T>(admin: SupabaseClient, fn: (batch: Batch) => Promise<T>): Promise<T> {
  const batch = new Batch(admin)
  try {
    return await fn(batch)
  } catch (e) {
    await batch.rollback()
    throw e instanceof Error ? e : new DbError(undefined, String(e))
  }
}

const projectKey = (p: { provider_id: string; external_project_id: string }) => `${p.provider_id}:${p.external_project_id}`

// ---------------------------------------------------------------------------
// Multi-select: one team for many rows
// ---------------------------------------------------------------------------

/** Put every person in `personIds` on `teamId` (null = Unassigned). Ids are validated by the caller. */
export async function bulkAssignPeople(admin: SupabaseClient, org: OrgSnapshot, personIds: string[], teamId: string | null): Promise<BulkRowResult[]> {
  const people = personIds.map((id) => org.people.find((p) => p.id === id)!)
  const moves = people.filter((p) => (p.team_id ?? null) !== teamId).map((p) => ({ id: p.id, from: p.team_id ?? null, to: teamId }))
  await inBatch(admin, (b) => b.moveTeams("people", moves))
  return people.map((p) => ({
    key: p.id,
    status: (p.team_id ?? null) === teamId ? "unchanged" : "updated",
    team_id: teamId,
    previous_team_id: p.team_id ?? null,
  }))
}

export interface ProjectRef {
  provider_id: string
  external_project_id: string
  name?: string | null
}

/**
 * Put every project on `teamId`. Registered projects are updated; projects
 * only seen in cost records are registered (one INSERT) with that team.
 */
export async function bulkAssignProjects(admin: SupabaseClient, org: OrgSnapshot, refs: ProjectRef[], teamId: string | null): Promise<BulkRowResult[]> {
  const rows = refs.map((r) => ({
    ref: r,
    existing: org.projects.find((p) => p.provider_id === r.provider_id && p.external_project_id === r.external_project_id) ?? null,
  }))
  const toInsert = rows.filter((r) => !r.existing && teamId !== null)
  const moves = rows
    .filter((r) => r.existing && (r.existing.team_id ?? null) !== teamId)
    .map((r) => ({ id: r.existing!.id, from: r.existing!.team_id ?? null, to: teamId }))

  await inBatch(admin, async (b) => {
    await b.insert(
      "org_projects",
      toInsert.map((r) => ({ provider_id: r.ref.provider_id, external_project_id: r.ref.external_project_id, name: r.ref.name ?? null, team_id: teamId })),
      "id"
    )
    await b.moveTeams("org_projects", moves)
  })

  return rows.map(({ ref, existing }): BulkRowResult => {
    const previous = existing?.team_id ?? null
    const status: BulkRowStatus = existing ? (previous === teamId ? "unchanged" : "updated") : teamId === null ? "unchanged" : "created"
    return { key: projectKey(ref), status, team_id: teamId, previous_team_id: previous }
  })
}

// ---------------------------------------------------------------------------
// CSV apply
// ---------------------------------------------------------------------------

export interface CsvApplyRow extends CsvRowResult {
  /** What the apply did: change rows become updated / created; everything else is skipped. */
  result: BulkRowStatus
  team_id: string | null
}

export interface CsvApplyResult {
  rows: CsvApplyRow[]
  created_teams: { id: string; name: string; department_id: string | null }[]
  applied: number
}

/**
 * Apply a preview built with the same CSV and org: create the unknown teams
 * it names (only when the preview was built with createTeams; otherwise those
 * rows are "unknown_team" and skipped), then move every "change" row. Rows of
 * any other status (unmatched, invalid, unchanged, unknown_team) are never
 * written.
 */
export async function applyCsv(admin: SupabaseClient, preview: CsvPreview): Promise<CsvApplyResult> {
  const changes = preview.rows.filter((r) => r.status === "change" && r.team)
  const needed = preview.unknown_teams.filter((u) => changes.some((r) => !r.team!.id && sameTeam(r, u)))

  return inBatch(admin, async (b) => {
    const created = await b.insert<{ id: string; name: string; department_id: string | null }>(
      "teams",
      needed.map((u) => ({ name: u.name, department_id: u.department_id })),
      "id, name, department_id"
    )
    const teamIdFor = (r: CsvRowResult): string => {
      if (r.team!.id) return r.team!.id
      const t = created.find((c) => targetTeamKey({ ...r.team!, id: null }) === targetTeamKey({ id: null, name: c.name, department_id: c.department_id, department_name: null }))
      if (!t) throw new DbError(undefined, `Team "${r.team!.name}" was not created`)
      return t.id
    }

    const resolved = changes.map((r) => ({ row: r, teamId: teamIdFor(r) }))
    const createdKeys = new Set<string>()

    if (preview.kind === "people") {
      await b.moveTeams(
        "people",
        resolved.map(({ row, teamId }) => ({ id: row.person_id!, from: row.current_team_id ?? null, to: teamId }))
      )
    } else {
      const fresh = resolved.filter(({ row }) => !row.project_id)
      await b.insert(
        "org_projects",
        fresh.map(({ row, teamId }) => ({
          provider_id: row.provider_id,
          external_project_id: row.external_project_id,
          name: row.project_name ?? null,
          team_id: teamId,
        })),
        "id"
      )
      for (const { row } of fresh) createdKeys.add(projectKey({ provider_id: row.provider_id!, external_project_id: row.external_project_id! }))
      await b.moveTeams(
        "org_projects",
        resolved.filter(({ row }) => row.project_id).map(({ row, teamId }) => ({ id: row.project_id!, from: row.current_team_id ?? null, to: teamId }))
      )
    }

    const byLine = new Map(resolved.map((r) => [r.row.line, r.teamId]))
    const rows: CsvApplyRow[] = preview.rows.map((r) => {
      const teamId = byLine.get(r.line)
      if (teamId === undefined) return { ...r, result: r.status === "unchanged" ? "unchanged" : "skipped", team_id: r.current_team_id ?? null }
      const isNew = preview.kind === "projects" && createdKeys.has(projectKey({ provider_id: r.provider_id!, external_project_id: r.external_project_id! }))
      return { ...r, result: isNew ? "created" : "updated", team_id: teamId }
    })
    return { rows, created_teams: created, applied: resolved.length }
  })
}

function sameTeam(r: CsvRowResult, u: UnknownTeam): boolean {
  return targetTeamKey({ ...r.team!, id: null }) === targetTeamKey({ id: null, name: u.name, department_id: u.department_id, department_name: null })
}
