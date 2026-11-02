/**
 * GET  /api/admin/org/departments — list departments
 * POST /api/admin/org/departments — { name, description? } create
 */

import { adminRoute, json, must, parseBody } from "@/lib/org/admin/http"
import { loadOrg } from "@/lib/org/admin/repo"
import { departmentCreateSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => {
  const rows = must(await admin.from("departments").select("id, name, description, created_at, updated_at").order("name"))
  return json(rows ?? [])
})

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, departmentCreateSchema(org))
  const row = must(
    await admin
      .from("departments")
      .insert({ name: body.name, description: body.description ?? null })
      .select("id, name, description, created_at, updated_at")
      .single()
  )
  return json(row, 201)
})
