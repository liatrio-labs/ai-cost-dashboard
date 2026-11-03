/**
 * PATCH /api/admin/org/people/:id — { email?, display_name?, team_id?, active? }
 *   Edit, assign to a team (team_id null = unassign) or deactivate
 *   (active: false). People are never hard-deleted: their identities and
 *   historical spend stay attributed.
 */

import { adminRoute, json, must, parseBody } from "@/lib/org/admin/http"
import { findOr404, loadOrg, refreshRollups } from "@/lib/org/admin/repo"
import { personUpdateSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Params = { id: string }

export const PATCH = adminRoute<Params>(async (request, { id }, admin) => {
  const org = await loadOrg(admin)
  const current = findOr404(org.people, id, "Person")
  const body = await parseBody(request, personUpdateSchema(org, id))
  const row = must(
    await admin
      .from("people")
      .update(body)
      .eq("id", id)
      .select("id, email, display_name, team_id, active, created_at, updated_at")
      .single()
  )
  const changesAttribution =
    (body.team_id !== undefined && body.team_id !== current.team_id) ||
    (body.email !== undefined && body.email !== current.email)
  if (changesAttribution) await refreshRollups()
  return json(row)
})
