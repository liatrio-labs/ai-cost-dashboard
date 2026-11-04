/**
 * POST /api/admin/org/unassigned/assign — one-click assign from the queue.
 *   { kind: "person",  email, display_name?, team_id }
 *       sets the person's team, creating the person if the email is new
 *   { kind: "api_key", provider_id, external_key_id, name?, team_id }
 *       registers the key if needed and sets its team (assignment_source
 *       "manual", so the AI Gateway key sync never overwrites it)
 *   { kind: "project", provider_id, external_project_id, name?, team_id }
 *       registers the project if needed and sets its team
 */

import { newPersonDisplayName } from "@/lib/org/display-name"
import { adminRoute, json, must, parseBody } from "@/lib/org/admin/http"
import { KEY_COLUMNS, loadOrg, refreshRollups } from "@/lib/org/admin/repo"
import { unassignedAssignSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, unassignedAssignSchema(org))
  let result: { kind: string; created: boolean; row: unknown }

  if (body.kind === "person") {
    const existing = org.people.find((p) => p.email === body.email)
    const select = "id, email, display_name, team_id, active"
    result = existing
      ? {
          kind: "person",
          created: false,
          row: must(await admin.from("people").update({ team_id: body.team_id }).eq("id", existing.id).select(select).single()),
        }
      : {
          kind: "person",
          created: true,
          row: must(
            await admin
              .from("people")
              .insert({ email: body.email, display_name: newPersonDisplayName(body.display_name, body.email), team_id: body.team_id, active: true })
              .select(select)
              .single()
          ),
        }
  } else if (body.kind === "api_key") {
    const existing = org.apiKeys.find(
      (k) => k.provider_id === body.provider_id && k.external_key_id === body.external_key_id
    )
    const select = KEY_COLUMNS
    result = existing
      ? {
          kind: "api_key",
          created: false,
          row: must(
            await admin
              .from("org_api_keys")
              .update({ team_id: body.team_id, assignment_source: "manual" })
              .eq("id", existing.id)
              .select(select)
              .single()
          ),
        }
      : {
          kind: "api_key",
          created: true,
          row: must(
            await admin
              .from("org_api_keys")
              .insert({
                provider_id: body.provider_id,
                external_key_id: body.external_key_id,
                name: body.name ?? null,
                team_id: body.team_id,
                assignment_source: "manual",
              })
              .select(select)
              .single()
          ),
        }
  } else {
    const existing = org.projects.find(
      (p) => p.provider_id === body.provider_id && p.external_project_id === body.external_project_id
    )
    const select = "id, provider_id, external_project_id, name, team_id"
    result = existing
      ? {
          kind: "project",
          created: false,
          row: must(await admin.from("org_projects").update({ team_id: body.team_id }).eq("id", existing.id).select(select).single()),
        }
      : {
          kind: "project",
          created: true,
          row: must(
            await admin
              .from("org_projects")
              .insert({
                provider_id: body.provider_id,
                external_project_id: body.external_project_id,
                name: body.name ?? null,
                team_id: body.team_id,
              })
              .select(select)
              .single()
          ),
        }
  }

  await refreshRollups()
  return json(result, result.created ? 201 : 200)
})
