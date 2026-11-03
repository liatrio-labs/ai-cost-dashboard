/**
 * GET  /api/admin/org/projects — every project seen in
 *      metadata.attribution.project_id, plus Anthropic workspaces seen in
 *      workspace_id (issue #28, kind "workspace"), merged with registered
 *      org_projects
 * POST /api/admin/org/projects — { provider_id, external_project_id, name?,
 *      team_id? } register or update a project's team (upsert)
 */

import { adminRoute, json, must, parseBody } from "@/lib/org/admin/http"
import { listProjects } from "@/lib/org/admin/observed"
import { loadOrg, refreshRollups, scanRecords } from "@/lib/org/admin/repo"
import { projectAssignSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => {
  const org = await loadOrg(admin)
  const [withProject, withWorkspace] = await Promise.all([
    scanRecords(admin, { requireField: "project_id" }),
    scanRecords(admin, { requireField: "workspace_id" }),
  ])
  // A row with both fields comes back from both scans; keep it once.
  const seen = new Set(withProject.map((r) => r.id))
  const records = [...withProject, ...withWorkspace.filter((r) => !r.id || !seen.has(r.id))]
  return json(listProjects(records, org.projects))
})

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, projectAssignSchema(org))
  const existing = org.projects.find(
    (p) => p.provider_id === body.provider_id && p.external_project_id === body.external_project_id
  )
  const fields: Record<string, unknown> = {}
  if (body.name !== undefined) fields.name = body.name
  if (body.team_id !== undefined) fields.team_id = body.team_id

  const select = "id, provider_id, external_project_id, name, team_id"
  const row = existing
    ? must(await admin.from("org_projects").update(fields).eq("id", existing.id).select(select).single())
    : must(
        await admin
          .from("org_projects")
          .insert({ provider_id: body.provider_id, external_project_id: body.external_project_id, ...fields })
          .select(select)
          .single()
      )
  await refreshRollups()
  return json(row, existing ? 200 : 201)
})
