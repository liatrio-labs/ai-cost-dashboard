/**
 * GET  /api/admin/org/api-keys[?days=N] — every key observed in
 *      metadata.attribution.api_key_id in the last N days (default 90), merged
 *      with every registered org_api_keys row, with spend and assignment.
 * POST /api/admin/org/api-keys — register or update a key's assignment:
 *      { provider_id, external_key_id, name?, owner_person_id?, team_id? }
 *      (upsert on provider + key id; omitted fields are left unchanged).
 *
 * Key metadata only: never send or store the secret.
 */

import { NextResponse, type NextRequest } from "next/server"
import { daysAgo, HttpError, loadCostRecords, loadOrgData, readJson, withAdmin } from "@/lib/org/admin-server"
import { listApiKeys } from "@/lib/org/observed"
import { lookbackDaysSchema, orgSchemas } from "@/lib/org/schemas"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DEFAULT_DAYS = 90

export async function GET(request: NextRequest) {
  return withAdmin("Failed to list API keys", async ({ admin }) => {
    const days = lookbackDaysSchema.parse(request.nextUrl.searchParams.get("days") ?? DEFAULT_DAYS)
    const [org, records] = await Promise.all([
      loadOrgData(admin),
      loadCostRecords(admin, { start: daysAgo(days), jsonPathNotNull: "metadata->attribution->>api_key_id" }),
    ])
    return NextResponse.json({ days, keys: listApiKeys(records, org) })
  })
}

export async function POST(request: Request) {
  return withAdmin("Failed to assign API key", async ({ admin }) => {
    const org = await loadOrgData(admin)
    const input = orgSchemas(org).apiKeyAssign.parse(await readJson(request))
    const provider = await admin.from("providers").select("id").eq("id", input.provider_id).maybeSingle()
    if (provider.error) throw provider.error
    if (!provider.data) throw new HttpError(400, "Unknown provider id")

    const existing = org.apiKeys.find(
      (k) => k.provider_id === input.provider_id && k.external_key_id === input.external_key_id
    )
    const fields: Record<string, unknown> = {}
    for (const key of ["name", "owner_person_id", "team_id"] as const) {
      if (input[key] !== undefined) fields[key] = input[key]
    }

    const result = existing
      ? await admin.from("org_api_keys").update(fields).eq("id", existing.id).select().single()
      : await admin
          .from("org_api_keys")
          .insert({ provider_id: input.provider_id, external_key_id: input.external_key_id, ...fields })
          .select()
          .single()
    if (result.error) throw result.error
    await refreshDailyAggregates()
    return NextResponse.json(result.data, { status: existing ? 200 : 201 })
  })
}
