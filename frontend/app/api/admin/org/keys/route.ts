/**
 * GET  /api/admin/org/keys — every key seen in metadata.attribution.api_key_id
 *      (with provider, latest name, spend) merged with registered org_api_keys
 * POST /api/admin/org/keys — { provider_id, external_key_id, name?,
 *      owner_person_id?, team_id?, org_project_id? } register or update a key's
 *      owner / team / project (upsert on provider + key id). Setting any of the
 *      three marks the key assignment_source "manual" (the AI Gateway key sync
 *      never overwrites it). Never accepts or stores a secret.
 */

import { adminRoute, json, must, parseBody } from "@/lib/org/admin/http"
import { listKeys } from "@/lib/org/admin/observed"
import { KEY_COLUMNS, loadOrg, refreshRollups, scanRecords } from "@/lib/org/admin/repo"
import { isManualAssignment, keyAssignSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => {
  const org = await loadOrg(admin)
  const records = await scanRecords(admin, { requireField: "api_key_id" })
  return json(listKeys(records, org.apiKeys))
})

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, keyAssignSchema(org))
  const existing = org.apiKeys.find(
    (k) => k.provider_id === body.provider_id && k.external_key_id === body.external_key_id
  )
  const fields: Record<string, unknown> = {}
  if (body.name !== undefined) fields.name = body.name
  if (body.owner_person_id !== undefined) fields.owner_person_id = body.owner_person_id
  if (body.team_id !== undefined) fields.team_id = body.team_id
  if (body.org_project_id !== undefined) fields.org_project_id = body.org_project_id
  if (isManualAssignment(body)) fields.assignment_source = "manual"

  const select = KEY_COLUMNS
  const row = existing
    ? must(await admin.from("org_api_keys").update(fields).eq("id", existing.id).select(select).single())
    : must(
        await admin
          .from("org_api_keys")
          .insert({ provider_id: body.provider_id, external_key_id: body.external_key_id, ...fields })
          .select(select)
          .single()
      )
  await refreshRollups()
  return json(row, existing ? 200 : 201)
})
