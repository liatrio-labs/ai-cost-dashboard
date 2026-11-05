/**
 * Admins list (issue #71). Admin-only: 401 signed out, 403 non-admin.
 *
 * GET    /api/admin/admins
 *   { me, env_admins: string[], env_domains: string[], admins: [{ email, added_by, added_at }],
 *     migration_applied, notice? }. env_admins are the ADMIN_EMAILS /
 *   DASHBOARD_OWNER_EMAIL allowlist (always admin, not removable here).
 * POST   /api/admin/admins          { email } — add an @liatrio.com address
 * DELETE /api/admin/admins?email=...&confirm=true — remove a table admin.
 *   Env admins and your own address cannot be removed.
 *
 * While migration 023 is not applied, GET answers migration_applied: false
 * with a notice and writes answer 409 (code migration_023_not_applied).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { HttpError, adminRoute, isConfirmed, json, parseBody } from "@/lib/org/admin/http"
import { getAdminDomains, getAdminEmails, isEnvAdminEmail } from "@/lib/db"
import {
  ADMIN_EMAIL_DOMAIN,
  MIGRATION_023_NOTICE,
  invalidateAdminUsersCache,
  isAllowedAdminEmail,
  isMissingAdminTable,
  listAdminUsers,
  normalizeEmail,
} from "@/lib/admin-users"
import { z } from "zod"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const addSchema = z.object({ email: z.string({ message: "email is required" }).min(1, "email is required") })

function migrationNotApplied(): never {
  throw new HttpError(409, MIGRATION_023_NOTICE, { code: "migration_023_not_applied" })
}

async function snapshot(admin: SupabaseClient, me: string) {
  const rows = await listAdminUsers(admin)
  return {
    me: normalizeEmail(me),
    env_admins: getAdminEmails(),
    env_domains: getAdminDomains(),
    admins: rows ?? [],
    migration_applied: rows !== null,
    ...(rows === null ? { notice: MIGRATION_023_NOTICE } : {}),
  }
}

export const GET = adminRoute(async (_request, _params, admin, user) => json(await snapshot(admin, user.email)))

export const POST = adminRoute(async (request, _params, admin, user) => {
  const { email: raw } = await parseBody(request, addSchema)
  const email = normalizeEmail(raw)
  if (!isAllowedAdminEmail(email)) {
    throw new HttpError(400, `Only @${ADMIN_EMAIL_DOMAIN} addresses can be admins (sign-in is Liatrio Google accounts).`)
  }
  if (isEnvAdminEmail(email)) throw new HttpError(409, `${email} is already an admin from the environment.`)

  const ins = await admin.from("admin_users").insert({ email, added_by: normalizeEmail(user.email) })
  if (isMissingAdminTable(ins.error)) migrationNotApplied()
  if (ins.error?.code === "23505") throw new HttpError(409, `${email} is already an admin.`)
  if (ins.error) throw new HttpError(500, ins.error.message || "Failed to add admin")
  invalidateAdminUsersCache()
  return json(await snapshot(admin, user.email), 201)
})

export const DELETE = adminRoute(async (request, _params, admin, user) => {
  const email = normalizeEmail(request.nextUrl.searchParams.get("email") ?? "")
  if (!email) throw new HttpError(400, "email is required")
  if (isEnvAdminEmail(email)) {
    throw new HttpError(400, `${email} is an admin from the environment and can't be removed here.`)
  }
  if (email === normalizeEmail(user.email)) throw new HttpError(400, "You can't remove yourself as an admin.")
  if (!isConfirmed(request)) throw new HttpError(400, `Retry with ?confirm=true to remove ${email} as an admin.`)

  const del = await admin.from("admin_users").delete().eq("email", email).select("email")
  if (isMissingAdminTable(del.error)) migrationNotApplied()
  if (del.error) throw new HttpError(500, del.error.message || "Failed to remove admin")
  if (!((del.data as unknown[] | null) ?? []).length) throw new HttpError(404, `${email} is not in the admin list.`)
  invalidateAdminUsersCache()
  return json(await snapshot(admin, user.email))
})
