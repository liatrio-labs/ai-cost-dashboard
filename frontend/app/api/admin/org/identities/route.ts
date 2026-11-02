/**
 * POST /api/admin/org/identities — { person_id, provider_id, external_id }
 *   Map a provider user / actor id (or an alias email the provider reports)
 *   to a person.
 */

import { adminRoute, json, must, parseBody } from "@/lib/org/admin/http"
import { loadOrg, refreshRollups } from "@/lib/org/admin/repo"
import { identityCreateSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, identityCreateSchema(org))
  const row = must(
    await admin
      .from("person_identities")
      .insert(body)
      .select("id, person_id, provider_id, external_id")
      .single()
  )
  await refreshRollups()
  return json(row, 201)
})
