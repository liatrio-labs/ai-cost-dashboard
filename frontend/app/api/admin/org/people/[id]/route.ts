/**
 * PATCH /api/admin/org/people/:id — edit { email?, display_name?, team_id?, active? }.
 * Deactivate with { active: false }. People are never hard-deleted here, so
 * their historical spend keeps its attribution.
 */

import { NextResponse, type NextRequest } from "next/server"
import { HttpError, loadOrgData, notFound, readJson, withAdmin } from "@/lib/org/admin-server"
import { orgSchemas } from "@/lib/org/schemas"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Ctx) {
  return withAdmin("Failed to update person", async ({ admin }) => {
    const { id } = await params
    const org = await loadOrgData(admin)
    if (!org.people.some((p) => p.id === id)) notFound("Person")
    const input = orgSchemas(org).personUpdate(id).parse(await readJson(request))
    const patch: Record<string, unknown> = {}
    for (const key of ["email", "display_name", "team_id", "active"] as const) {
      if (input[key] !== undefined) patch[key] = input[key]
    }
    if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to update")
    const { data, error } = await admin.from("people").update(patch).eq("id", id).select().single()
    if (error) throw error
    if (patch.email !== undefined || patch.team_id !== undefined) await refreshDailyAggregates()
    return NextResponse.json(data)
  })
}
