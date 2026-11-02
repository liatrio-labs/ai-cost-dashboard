/**
 * PATCH  /api/admin/org/api-keys/:id — { name?, owner_person_id?, team_id? }
 * DELETE /api/admin/org/api-keys/:id — unregister the key (its spend goes back
 *        to whatever the person resolves to, or Unassigned).
 */

import { NextResponse, type NextRequest } from "next/server"
import { HttpError, loadOrgData, notFound, readJson, withAdmin } from "@/lib/org/admin-server"
import { orgSchemas } from "@/lib/org/schemas"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Ctx) {
  return withAdmin("Failed to update API key", async ({ admin }) => {
    const { id } = await params
    const org = await loadOrgData(admin)
    if (!org.apiKeys.some((k) => k.id === id)) notFound("API key")
    const input = orgSchemas(org).apiKeyUpdate.parse(await readJson(request))
    const patch: Record<string, unknown> = {}
    for (const key of ["name", "owner_person_id", "team_id"] as const) {
      if (input[key] !== undefined) patch[key] = input[key]
    }
    if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to update")
    const { data, error } = await admin.from("org_api_keys").update(patch).eq("id", id).select().single()
    if (error) throw error
    await refreshDailyAggregates()
    return NextResponse.json(data)
  })
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  return withAdmin("Failed to delete API key", async ({ admin }) => {
    const { id } = await params
    const org = await loadOrgData(admin)
    if (!org.apiKeys.some((k) => k.id === id)) notFound("API key")
    const { error } = await admin.from("org_api_keys").delete().eq("id", id)
    if (error) throw error
    await refreshDailyAggregates()
    return NextResponse.json({ deleted: id })
  })
}
