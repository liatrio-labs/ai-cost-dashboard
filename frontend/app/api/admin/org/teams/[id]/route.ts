/**
 * PATCH  /api/admin/org/teams/:id                — rename / move { name?, department_id? }
 * DELETE /api/admin/org/teams/:id[?confirm=true] — blocked (409) while people
 *        or API keys belong to it; with confirm=true they move to no team
 *        (Unassigned) and the team is deleted.
 */

import { NextResponse, type NextRequest } from "next/server"
import { HttpError, loadOrgData, notFound, readJson, withAdmin } from "@/lib/org/admin-server"
import { orgSchemas } from "@/lib/org/schemas"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Ctx) {
  return withAdmin("Failed to update team", async ({ admin }) => {
    const { id } = await params
    const org = await loadOrgData(admin)
    if (!org.teams.some((t) => t.id === id)) notFound("Team")
    const input = orgSchemas(org).teamUpdate(id).parse(await readJson(request))
    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.department_id !== undefined) patch.department_id = input.department_id
    if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to update")
    const { data, error } = await admin.from("teams").update(patch).eq("id", id).select().single()
    if (error) throw error
    if (patch.department_id !== undefined) await refreshDailyAggregates()
    return NextResponse.json(data)
  })
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  return withAdmin("Failed to delete team", async ({ admin }) => {
    const { id } = await params
    const confirm = request.nextUrl.searchParams.get("confirm") === "true"
    const org = await loadOrgData(admin)
    const team = org.teams.find((t) => t.id === id) ?? notFound("Team")
    const people = org.people.filter((p) => p.team_id === id).length
    const apiKeys = org.apiKeys.filter((k) => k.team_id === id).length
    if ((people || apiKeys) && !confirm) {
      throw new HttpError(
        409,
        `Team "${team.name}" still has ${people} person(s) and ${apiKeys} API key(s). Reassign them first, or confirm to move them to Unassigned.`,
        { blocked: true, people, api_keys: apiKeys }
      )
    }
    if (people) {
      const { error } = await admin.from("people").update({ team_id: null }).eq("team_id", id)
      if (error) throw error
    }
    if (apiKeys) {
      const { error } = await admin.from("org_api_keys").update({ team_id: null }).eq("team_id", id)
      if (error) throw error
    }
    const { error } = await admin.from("teams").delete().eq("id", id)
    if (error) throw error
    await refreshDailyAggregates()
    return NextResponse.json({ deleted: id, people_unassigned: people, api_keys_unassigned: apiKeys })
  })
}
