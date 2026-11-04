/**
 * POST /api/admin/org/people/bulk — { person_ids: string[], team_id: string | null }
 *
 * Multi-select "Assign team" (issue #43): puts every listed person on one
 * team (null = Unassigned). All ids are validated first (unknown id or team =
 * 400, nothing written); the write is one UPDATE per batch. Returns a result
 * per person: updated or unchanged.
 */

import { adminRoute, json, parseBody } from "@/lib/org/admin/http"
import { bulkAssignPeople } from "@/lib/org/admin/bulk"
import { loadOrg, refreshRollups } from "@/lib/org/admin/repo"
import { bulkPeopleTeamSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, bulkPeopleTeamSchema(org))
  const results = await bulkAssignPeople(admin, org, body.person_ids, body.team_id)
  const updated = results.filter((r) => r.status === "updated").length
  if (updated) await refreshRollups()
  return json({ team_id: body.team_id, updated, unchanged: results.length - updated, results })
})
