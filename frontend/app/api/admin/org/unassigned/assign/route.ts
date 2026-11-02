/**
 * POST /api/admin/org/unassigned/assign — one-click assign from the queue.
 *
 * { kind: "person", email, display_name?, team_id }
 *     Sets the person's team, creating the person if the email is new.
 * { kind: "api_key", provider_id, external_key_id, name?, team_id }
 *     Registers the key (or updates it) with the team.
 */

import { NextResponse } from "next/server"
import { HttpError, loadOrgData, readJson, withAdmin } from "@/lib/org/admin-server"
import { orgSchemas } from "@/lib/org/schemas"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return withAdmin("Failed to assign", async ({ admin }) => {
    const org = await loadOrgData(admin)
    const input = orgSchemas(org).unassignedAssign.parse(await readJson(request))

    if (input.kind === "person") {
      const person = org.people.find((p) => p.email === input.email)
      const result = person
        ? await admin.from("people").update({ team_id: input.team_id }).eq("id", person.id).select().single()
        : await admin
            .from("people")
            .insert({ email: input.email, display_name: input.display_name ?? null, team_id: input.team_id, active: true })
            .select()
            .single()
      if (result.error) throw result.error
      await refreshDailyAggregates()
      return NextResponse.json({ kind: "person", created: !person, person: result.data })
    }

    const provider = await admin.from("providers").select("id").eq("id", input.provider_id).maybeSingle()
    if (provider.error) throw provider.error
    if (!provider.data) throw new HttpError(400, "Unknown provider id")
    const key = org.apiKeys.find(
      (k) => k.provider_id === input.provider_id && k.external_key_id === input.external_key_id
    )
    const result = key
      ? await admin.from("org_api_keys").update({ team_id: input.team_id }).eq("id", key.id).select().single()
      : await admin
          .from("org_api_keys")
          .insert({
            provider_id: input.provider_id,
            external_key_id: input.external_key_id,
            name: input.name ?? null,
            team_id: input.team_id,
          })
          .select()
          .single()
    if (result.error) throw result.error
    await refreshDailyAggregates()
    return NextResponse.json({ kind: "api_key", created: !key, api_key: result.data })
  })
}
