/**
 * Shared writes for the key syncs (gateway-sync.ts, anthropic-key-sync.ts):
 * people matched by email (else created with no team) and org_projects
 * upserts that only ever fill a missing name, never rename a project or touch
 * its team.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { backfillDefaultDisplayNames, newPersonDisplayName, type PersonNameRow } from "./display-name"

/** True when a Postgres / PostgREST error says a column doesn't exist (an unapplied migration). */
export function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204" || /column .* does not exist/i.test(error.message ?? ""))
}

/**
 * A provider's key creation time as an ISO string, or null when absent or
 * unparseable (issue #44). Numbers (and numeric strings) are epoch seconds
 * (Anthropic / OpenAI style) or, from 1e11 up, epoch milliseconds (Vercel
 * createdAt); other strings go through Date.parse (RFC 3339).
 */
export function parseProviderTimestamp(v: unknown): string | null {
  const text = typeof v === "string" ? v.trim() : ""
  const numeric = typeof v === "number" ? v : /^\d+(\.\d+)?$/.test(text) ? Number(text) : null
  let ms: number
  if (numeric !== null) ms = numeric < 1e11 ? numeric * 1000 : numeric
  else if (text) ms = Date.parse(text)
  else return null
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return null
  return new Date(ms).toISOString()
}

/**
 * The provider_created_at to write (migration 018), or undefined for no
 * change: only a known date that differs from the stored one is written, so
 * a provider that stops reporting it never clears a stored date. Compared as
 * instants (PostgREST returns "+00:00", we send "Z").
 */
export function providerCreatedAtChange(stored: string | null | undefined, incoming: string | null | undefined): string | undefined {
  if (!incoming) return undefined
  if (stored && Date.parse(stored) === Date.parse(incoming)) return undefined
  return incoming
}

/** Select org_api_keys with the first column set that exists (newest first); returns the result and its index. */
export async function selectKeyTier<R extends { data: unknown; error: { code?: string; message?: string } | null }>(
  tiers: string[],
  read: (columns: string) => PromiseLike<R>
): Promise<{ res: R; tier: number }> {
  let res = await read(tiers[0])
  let tier = 0
  while (isMissingColumn(res.error) && tier < tiers.length - 1) res = await read(tiers[++tier])
  return { res, tier }
}

export function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

/**
 * people.id for every wanted email (lower-cased; value = display name for a
 * new row). Existing people are matched by email; the rest are created with no
 * team. A concurrent insert (23505) is read back. New people get a real given
 * name or else the firstname.lastname default; matched people with a
 * placeholder name get that default filled in (issue #66).
 */
export async function ensurePeople(
  admin: SupabaseClient,
  wanted: Map<string, string | null>
): Promise<{ personByEmail: Map<string, string>; created: number; named: number }> {
  const personByEmail = new Map<string, string>()
  let created = 0
  if (!wanted.size) return { personByEmail, created, named: 0 }
  const emails = [...wanted.keys()]
  const found = must(
    await admin.from("people").select("id, email, display_name").in("email", emails),
    "Failed to read people"
  ) as PersonNameRow[]
  for (const p of found ?? []) personByEmail.set(p.email, p.id)
  const named = await backfillDefaultDisplayNames(admin, found ?? [])
  for (const email of emails) {
    if (personByEmail.has(email)) continue
    const res = await admin
      .from("people")
      .insert({ email, display_name: newPersonDisplayName(wanted.get(email), email), team_id: null, active: true })
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
  return { personByEmail, created, named }
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
