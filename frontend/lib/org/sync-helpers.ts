/**
 * Shared writes for the key syncs (gateway-sync.ts, anthropic-key-sync.ts):
 * people matched by email (else created with no team) and org_projects
 * upserts that only ever fill a missing name, never rename a project or touch
 * its team.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

/** True when a Postgres / PostgREST error says a column doesn't exist (an unapplied migration). */
export function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204" || /column .* does not exist/i.test(error.message ?? ""))
}

export function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

/**
 * people.id for every wanted email (lower-cased; value = display name for a
 * new row). Existing people are matched by email; the rest are created with no
 * team. A concurrent insert (23505) is read back.
 */
export async function ensurePeople(
  admin: SupabaseClient,
  wanted: Map<string, string | null>
): Promise<{ personByEmail: Map<string, string>; created: number }> {
  const personByEmail = new Map<string, string>()
  let created = 0
  if (!wanted.size) return { personByEmail, created }
  const emails = [...wanted.keys()]
  const found = must(await admin.from("people").select("id, email").in("email", emails), "Failed to read people") as {
    id: string
    email: string
  }[]
  for (const p of found ?? []) personByEmail.set(p.email, p.id)
  for (const email of emails) {
    if (personByEmail.has(email)) continue
    const res = await admin
      .from("people")
      .insert({ email, display_name: wanted.get(email) ?? null, team_id: null, active: true })
      .select("id, email")
      .single()
    if (res.error?.code === "23505") {
      const again = must(await admin.from("people").select("id, email").eq("email", email).single(), "Failed to read person") as { id: string }
      personByEmail.set(email, again.id)
      continue
    }
    personByEmail.set(email, (must(res, "Failed to create person") as { id: string }).id)
    created++
  }
  return { personByEmail, created }
}

/**
 * org_projects.id for every wanted external project id (value = name, or
 * null when unknown). Existing rows only get a missing name filled in; new
 * rows are created with no team.
 */
export async function ensureProjects(
  admin: SupabaseClient,
  providerId: string,
  wanted: Map<string, string | null>
): Promise<{ projectByExternal: Map<string, string>; created: number }> {
  const projectByExternal = new Map<string, string>()
  let created = 0
  if (!wanted.size) return { projectByExternal, created }
  const ids = [...wanted.keys()]
  const found = must(
    await admin.from("org_projects").select("id, external_project_id, name").eq("provider_id", providerId).in("external_project_id", ids),
    "Failed to read org_projects"
  ) as { id: string; external_project_id: string; name: string | null }[]
  for (const p of found ?? []) {
    projectByExternal.set(p.external_project_id, p.id)
    const name = wanted.get(p.external_project_id)
    // Fill a missing name only; never rename or touch the team.
    if (!p.name && name) {
      must(await admin.from("org_projects").update({ name }).eq("id", p.id).select("id"), "Failed to update org_projects")
    }
  }
  for (const id of ids) {
    if (projectByExternal.has(id)) continue
    const res = await admin
      .from("org_projects")
      .insert({ provider_id: providerId, external_project_id: id, name: wanted.get(id) ?? null })
      .select("id")
      .single()
    if (res.error?.code === "23505") {
      const again = must(
        await admin.from("org_projects").select("id").eq("provider_id", providerId).eq("external_project_id", id).single(),
        "Failed to read org_projects"
      ) as { id: string }
      projectByExternal.set(id, again.id)
      continue
    }
    projectByExternal.set(id, (must(res, "Failed to create org_projects row") as { id: string }).id)
    created++
  }
  return { projectByExternal, created }
}
