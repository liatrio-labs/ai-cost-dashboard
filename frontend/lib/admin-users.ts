/**
 * The editable admin list (issue #71): rows in admin_users (migration 023),
 * read and written with the service-role client only. Env-allowlist admins
 * (ADMIN_EMAILS / DASHBOARD_OWNER_EMAIL) live in lib/db.ts and are never
 * stored here.
 *
 * Degrades safely while 023 is not applied: a missing table reads as "no
 * table admins" (so only env-allowlist admins exist) and writes answer 409
 * with code migration_023_not_applied.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { createAdminClient } from "@/lib/supabase/admin"

export const ADMIN_EMAIL_DOMAIN = "liatrio.com"

export const MIGRATION_023_NOTICE =
  "Migration 023 not applied: only admins from the environment can sign in to /admin, and adding or removing admins is unavailable until database/migrations/023_admin_users.sql is applied."

export interface AdminUserRow {
  email: string
  added_by: string | null
  added_at: string
}

/** null = admin_users does not exist (migration 023 not applied). */
export type AdminUsersResult = AdminUserRow[] | null

type PgError = { code?: string; message?: string } | null | undefined

/** "table does not exist" from Postgres (42P01) or PostgREST (PGRST205, schema cache). */
export function isMissingAdminTable(error: PgError): boolean {
  return (
    !!error &&
    (error.code === "42P01" ||
      error.code === "PGRST205" ||
      /relation .* does not exist|could not find the table/i.test(error.message ?? ""))
  )
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** A plausible single address under @liatrio.com (sign-in is Liatrio Google accounts only). */
export function isAllowedAdminEmail(email: string): boolean {
  const e = normalizeEmail(email)
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(e)
  return !!m && m[2] === ADMIN_EMAIL_DOMAIN
}

const CACHE_TTL_MS = 30_000
let cache: { at: number; emails: Set<string> | null } | null = null

/** Drop the cached table-admin set (after an add or remove, and in tests). */
export function invalidateAdminUsersCache(): void {
  cache = null
}

/** All admin_users rows, oldest first, or null when the table is missing. Throws other errors. */
export async function listAdminUsers(admin: SupabaseClient): Promise<AdminUsersResult> {
  const res = await admin.from("admin_users").select("email, added_by, added_at").order("added_at", { ascending: true })
  if (isMissingAdminTable(res.error)) return null
  if (res.error) throw new Error(res.error.message || "Failed to load admin_users")
  return (res.data ?? []) as AdminUserRow[]
}

/**
 * The lowercased table-admin emails, cached for 30s. Any failure (no service
 * credentials, table missing, query error) yields an empty set, so the admin
 * check falls back to the env allowlist and never throws.
 */
export async function getTableAdminEmails(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.emails ?? new Set()
  try {
    const rows = await listAdminUsers(createAdminClient())
    const emails = rows ? new Set(rows.map((r) => normalizeEmail(r.email))) : null
    cache = { at: Date.now(), emails }
    return emails ?? new Set()
  } catch (e) {
    // Not cached, so the next request retries.
    console.error("admin_users lookup failed:", e instanceof Error ? e.message : e)
    return new Set()
  }
}

export async function isTableAdminEmail(email: string): Promise<boolean> {
  return (await getTableAdminEmails()).has(normalizeEmail(email))
}
