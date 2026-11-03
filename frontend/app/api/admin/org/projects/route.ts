/**
 * GET  /api/admin/org/projects — every project seen in
 *      metadata.attribution.project_id merged with registered org_projects
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
  const records = await scanRecords(admin, { requireField: "project_id" })
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
