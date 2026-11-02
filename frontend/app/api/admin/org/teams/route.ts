/**
 * GET  /api/admin/org/teams — list teams
 * POST /api/admin/org/teams — { name, department_id? } create
 */

import { adminRoute, json, must, parseBody } from "@/lib/org/admin/http"
import { loadOrg } from "@/lib/org/admin/repo"
import { teamCreateSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => {
  const rows = must(await admin.from("teams").select("id, name, department_id, created_at, updated_at").order("name"))
  return json(rows ?? [])
})

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, teamCreateSchema(org))
  const row = must(
    await admin
      .from("teams")
      .insert({ name: body.name, department_id: body.department_id ?? null })
      .select("id, name, department_id, created_at, updated_at")
      .single()
  )
  return json(row, 201)
})
