/**
 * POST /api/admin/org/people — add { email, display_name?, team_id?, active? }.
 * Emails are trimmed and lower-cased.
 */

import { NextResponse } from "next/server"
import { loadOrgData, readJson, withAdmin } from "@/lib/org/admin-server"
import { orgSchemas } from "@/lib/org/schemas"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return withAdmin("Failed to add person", async ({ admin }) => {
    const input = orgSchemas(await loadOrgData(admin)).personCreate.parse(await readJson(request))
    const { data, error } = await admin
      .from("people")
      .insert({
        email: input.email,
        display_name: input.display_name ?? null,
        team_id: input.team_id,
        active: input.active ?? true,
      })
      .select()
      .single()
    if (error) throw error
    await refreshDailyAggregates()
    return NextResponse.json(data, { status: 201 })
  })
}
