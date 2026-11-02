/**
 * PATCH  /api/admin/org/departments/:id                — rename { name?, description? }
 * DELETE /api/admin/org/departments/:id[?confirm=true] — blocked (409) while
 *        teams belong to it; with confirm=true its teams move to no department
 *        (Unassigned) and the department is deleted.
 */

import { NextResponse, type NextRequest } from "next/server"
import { HttpError, loadOrgData, notFound, readJson, withAdmin } from "@/lib/org/admin-server"
import { orgSchemas } from "@/lib/org/schemas"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Ctx) {
  return withAdmin("Failed to update department", async ({ admin }) => {
    const { id } = await params
    const org = await loadOrgData(admin)
    if (!org.departments.some((d) => d.id === id)) notFound("Department")
    const input = orgSchemas(org).departmentUpdate(id).parse(await readJson(request))
    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.description !== undefined) patch.description = input.description
    if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to update")
    const { data, error } = await admin.from("departments").update(patch).eq("id", id).select().single()
    if (error) throw error
    return NextResponse.json(data)
  })
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  return withAdmin("Failed to delete department", async ({ admin }) => {
    const { id } = await params
    const confirm = request.nextUrl.searchParams.get("confirm") === "true"
    const org = await loadOrgData(admin)
    const dept = org.departments.find((d) => d.id === id) ?? notFound("Department")
    const teams = org.teams.filter((t) => t.department_id === id)
    if (teams.length && !confirm) {
      throw new HttpError(
        409,
        `Department "${dept.name}" still has ${teams.length} team(s). Move or delete them first, or confirm to move them to Unassigned.`,
        { blocked: true, teams: teams.length }
      )
    }
    if (teams.length) {
      const { error } = await admin.from("teams").update({ department_id: null }).eq("department_id", id)
      if (error) throw error
    }
    const { error } = await admin.from("departments").delete().eq("id", id)
    if (error) throw error
    if (teams.length) await refreshDailyAggregates()
    return NextResponse.json({ deleted: id, teams_unassigned: teams.length })
  })
}
