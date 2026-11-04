/**
 * GET  /api/admin/org/people — list people (with their identities)
 * POST /api/admin/org/people — { email, display_name?, team_id? } add
 */

import { newPersonDisplayName } from "@/lib/org/display-name"
import { adminRoute, json, must, parseBody } from "@/lib/org/admin/http"
import { loadOrg, refreshRollups } from "@/lib/org/admin/repo"
import { personCreateSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => {
  const org = await loadOrg(admin)
  return json(
    org.people.map((p) => ({ ...p, identities: org.identities.filter((i) => i.person_id === p.id) }))
  )
})

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, personCreateSchema(org))
  const row = must(
    await admin
      .from("people")
      .insert({
        email: body.email,
        display_name: newPersonDisplayName(body.display_name, body.email),
        team_id: body.team_id ?? null,
        active: body.active ?? true,
      })
      .select("id, email, display_name, team_id, active, created_at, updated_at")
      .single()
  )
  // A new email can claim spend that was Unassigned.
  await refreshRollups()
  return json(row, 201)
})
