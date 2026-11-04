/**
 * POST /api/admin/org/projects/bulk — { projects: [{ provider_id,
 *      external_project_id, name? }], team_id: string | null }
 *
 * Multi-select "Assign team" (issue #43): puts every listed project on one
 * team (null = no team). Registered projects are updated; projects only seen
 * in cost records are registered with that team. Validated first (unknown
 * team or provider = 400, nothing written); a failed write is undone. Returns
 * a result per project: updated, created or unchanged.
 */

import { adminRoute, json, parseBody } from "@/lib/org/admin/http"
import { bulkAssignProjects } from "@/lib/org/admin/bulk"
import { loadOrg, refreshRollups } from "@/lib/org/admin/repo"
import { bulkProjectsTeamSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, bulkProjectsTeamSchema(org))
  const results = await bulkAssignProjects(admin, org, body.projects, body.team_id)
  const changed = results.filter((r) => r.status !== "unchanged").length
  if (changed) await refreshRollups()
  return json({
    team_id: body.team_id,
    updated: results.filter((r) => r.status === "updated").length,
    created: results.filter((r) => r.status === "created").length,
    unchanged: results.length - changed,
    results,
  })
})
