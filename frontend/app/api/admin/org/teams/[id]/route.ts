/**
 * PATCH  /api/admin/org/teams/:id — { name?, department_id? } rename and/or
 *        move between departments (department_id null = no department)
 * DELETE /api/admin/org/teams/:id[?confirm=true]
 *   Blocked with 409 while people, API keys or projects are assigned to it.
 *   With confirm=true they are unassigned (team_id null) first, so their
 *   spend moves to Unassigned.
 */

import { HttpError, adminRoute, isConfirmed, json, must, parseBody } from "@/lib/org/admin/http"
import { findOr404, loadOrg, refreshRollups } from "@/lib/org/admin/repo"
import { teamUpdateSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Params = { id: string }

export const PATCH = adminRoute<Params>(async (request, { id }, admin) => {
  const org = await loadOrg(admin)
  const current = findOr404(org.teams, id, "Team")
  const body = await parseBody(request, teamUpdateSchema(org, id))
  const row = must(
    await admin
      .from("teams")
      .update(body)
      .eq("id", id)
      .select("id, name, department_id, created_at, updated_at")
      .single()
  )
  const moved = body.department_id !== undefined && body.department_id !== (current.department_id ?? null)
  if (moved) await refreshRollups()
  return json(row)
})

export const DELETE = adminRoute<Params>(async (request, { id }, admin) => {
  const org = await loadOrg(admin)
  const team = findOr404(org.teams, id, "Team")
  const people = org.people.filter((p) => p.team_id === id)
  const keys = org.apiKeys.filter((k) => k.team_id === id)
  const projects = org.projects.filter((p) => p.team_id === id)
  const members = people.length + keys.length + projects.length

  if (members && !isConfirmed(request)) {
    throw new HttpError(
      409,
      `Team "${team.name}" still has ${people.length} person(s), ${keys.length} API key(s) and ${projects.length} project(s). Reassign them first, or retry with ?confirm=true to move them to Unassigned.`,
      {
        blockers: {
          people: people.map((p) => ({ id: p.id, email: p.email })),
          api_keys: keys.map((k) => ({ id: k.id, external_key_id: k.external_key_id })),
          projects: projects.map((p) => ({ id: p.id, external_project_id: p.external_project_id })),
        },
      }
    )
  }
  if (people.length) must(await admin.from("people").update({ team_id: null }).eq("team_id", id).select("id"))
  if (keys.length) must(await admin.from("org_api_keys").update({ team_id: null }).eq("team_id", id).select("id"))
  if (projects.length) must(await admin.from("org_projects").update({ team_id: null }).eq("team_id", id).select("id"))
  must(await admin.from("teams").delete().eq("id", id).select("id"))
  await refreshRollups()
  return json({
    deleted: id,
    reassigned: { people: people.length, api_keys: keys.length, projects: projects.length },
  })
})
