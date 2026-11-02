/**
 * POST /api/admin/org/identities — map a provider user id or email to a person:
 * { person_id, provider_id, external_id }.
 */

import { NextResponse } from "next/server"
import { HttpError, loadOrgData, readJson, withAdmin } from "@/lib/org/admin-server"
import { orgSchemas } from "@/lib/org/schemas"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return withAdmin("Failed to add identity", async ({ admin }) => {
    const input = orgSchemas(await loadOrgData(admin)).identityCreate.parse(await readJson(request))
    const provider = await admin.from("providers").select("id").eq("id", input.provider_id).maybeSingle()
    if (provider.error) throw provider.error
    if (!provider.data) throw new HttpError(400, "Unknown provider id")
    const { data, error } = await admin.from("person_identities").insert(input).select().single()
    if (error) throw error
    await refreshDailyAggregates()
    return NextResponse.json(data, { status: 201 })
  })
}
