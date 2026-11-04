/**
 * POST /api/admin/org/import/csv — { kind: "people" | "projects", csv,
 *      confirm?, create_teams? }
 *
 * CSV team assignment (issue #43; format and matching rules in
 * lib/org/admin/csv.ts):
 *   people:   email,team[,department]
 *   projects: project,team
 *
 * Without confirm: true it is a dry run: per-row status (change, unchanged,
 * unmatched, unknown_team, invalid), counts and the unknown teams. Nothing is
 * written. With confirm: true the same preview is rebuilt from current data
 * and only its "change" rows are written (unknown teams are created first
 * when create_teams is set); unmatched and invalid rows are never written.
 */

import { adminRoute, json, parseBody, HttpError } from "@/lib/org/admin/http"
import { applyCsv } from "@/lib/org/admin/bulk"
import { MAX_CSV_ROWS, dataRows, previewPeopleCsv, previewProjectsCsv, projectCandidates } from "@/lib/org/admin/csv"
import { listProjects } from "@/lib/org/admin/observed"
import { loadOrg, refreshRollups, scanRecords } from "@/lib/org/admin/repo"
import { csvImportSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin) => {
  const body = await parseBody(request, csvImportSchema)
  if (dataRows(body.csv, body.kind).length > MAX_CSV_ROWS) {
    throw new HttpError(400, `CSV has more than ${MAX_CSV_ROWS} rows`)
  }
  const org = await loadOrg(admin)
  const opts = { createTeams: body.create_teams === true }

  let preview
  if (body.kind === "people") {
    preview = previewPeopleCsv(body.csv, org, opts)
  } else {
    const [withProject, withWorkspace] = await Promise.all([
      scanRecords(admin, { requireField: "project_id" }),
      scanRecords(admin, { requireField: "workspace_id" }),
    ])
    const seen = new Set(withProject.map((r) => r.id))
    const records = [...withProject, ...withWorkspace.filter((r) => !r.id || !seen.has(r.id))]
    preview = previewProjectsCsv(body.csv, org, projectCandidates(listProjects(records, org.projects), org.projects), opts)
  }

  if (body.confirm !== true) return json({ dry_run: true, create_teams: opts.createTeams, ...preview })

  const result = await applyCsv(admin, preview)
  if (result.applied) await refreshRollups()
  return json({
    dry_run: false,
    create_teams: opts.createTeams,
    kind: preview.kind,
    counts: preview.counts,
    unknown_teams: preview.unknown_teams,
    applied: result.applied,
    created_teams: result.created_teams,
    rows: result.rows,
  })
})
