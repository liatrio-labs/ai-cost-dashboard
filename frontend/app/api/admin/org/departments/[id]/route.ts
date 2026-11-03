/**
 * PATCH  /api/admin/org/departments/:id — { name?, description? } rename
 * DELETE /api/admin/org/departments/:id[?confirm=true]
 *   Blocked with 409 while teams belong to it. With confirm=true those teams
 *   move to "no department" (Unassigned at the department level) first.
 */

import { HttpError, adminRoute, isConfirmed, json, must, parseBody } from "@/lib/org/admin/http"
import { findOr404, loadOrg, refreshRollups } from "@/lib/org/admin/repo"
import { departmentUpdateSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Params = { id: string }

export const PATCH = adminRoute<Params>(async (request, { id }, admin) => {
  const org = await loadOrg(admin)
  findOr404(org.departments, id, "Department")
  const body = await parseBody(request, departmentUpdateSchema(org, id))
  const row = must(
    await admin
      .from("departments")
      .update(body)
      .eq("id", id)
      .select("id, name, description, created_at, updated_at")
      .single()
  )
  return json(row)
})

export const DELETE = adminRoute<Params>(async (request, { id }, admin) => {
  const org = await loadOrg(admin)
  const dept = findOr404(org.departments, id, "Department")
  const teams = org.teams.filter((t) => t.department_id === id)

  if (teams.length && !isConfirmed(request)) {
    throw new HttpError(
      409,
      `Department "${dept.name}" still has ${teams.length} team(s). Move or delete them first, or retry with ?confirm=true to move them to Unassigned.`,
      { blockers: { teams: teams.map((t) => ({ id: t.id, name: t.name })) } }
    )
  }
  if (teams.length) {
    must(await admin.from("teams").update({ department_id: null }).eq("department_id", id).select("id"))
  }
  must(await admin.from("departments").delete().eq("id", id).select("id"))
  if (teams.length) await refreshRollups()
  return json({ deleted: id, reassigned: { teams: teams.length } })
})
