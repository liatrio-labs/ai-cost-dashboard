/**
 * Server-only plumbing shared by the /api/admin/org/* routes (issue #7):
 * the requireAdmin wrapper, error -> status mapping, and reads of the org
 * tables and cost_records through the service-role client.
 */

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { ZodError } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { requireAdmin } from "@/lib/db"
import { createAdminClient } from "@/lib/supabase/admin"
import type { ObservedRecord } from "./observed"
import type { OrgData } from "./types"

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message)
  }
}

export interface AdminContext {
  admin: SupabaseClient
  user: { id: string; email: string }
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") return e.message
  return "Request failed"
}

/** Map a thrown value to a JSON error response. */
export function toErrorResponse(e: unknown, fallback: string): NextResponse {
  if (e instanceof HttpError) {
    return NextResponse.json({ error: e.message, ...e.details }, { status: e.status })
  }
  if (e instanceof ZodError) {
    const issues = e.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
    return NextResponse.json({ error: issues[0]?.message || "Invalid input", issues }, { status: 400 })
  }
  const message = errorMessage(e)
  if (message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const code = e && typeof e === "object" && "code" in e ? (e as { code?: unknown }).code : undefined
  if (code === "23505") return NextResponse.json({ error: "Already exists", detail: message }, { status: 409 })
  if (code === "23503") return NextResponse.json({ error: "Referenced row does not exist", detail: message }, { status: 400 })
  if (code === "23514") return NextResponse.json({ error: "Invalid value", detail: message }, { status: 400 })
  return NextResponse.json({ error: message || fallback }, { status: 500 })
}

/** Run a handler as an authenticated admin with the service-role client. */
export async function withAdmin(fallback: string, handler: (ctx: AdminContext) => Promise<NextResponse>) {
  try {
    const user = await requireAdmin(await cookies())
    return await handler({ admin: createAdminClient(), user })
  } catch (e) {
    return toErrorResponse(e, fallback)
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HttpError(400, "Request body must be JSON")
  }
}

function check<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw result.error
  return (result.data ?? []) as T
}

export async function loadOrgData(admin: SupabaseClient): Promise<OrgData> {
  const [departments, teams, people, identities, apiKeys] = await Promise.all([
    admin.from("departments").select("id, name, description, created_at, updated_at").order("name"),
    admin.from("teams").select("id, name, department_id, created_at, updated_at").order("name"),
    admin.from("people").select("id, email, display_name, team_id, active, created_at, updated_at").order("email"),
    admin.from("person_identities").select("id, person_id, provider_id, external_id"),
    admin.from("org_api_keys").select("id, provider_id, external_key_id, name, owner_person_id, team_id"),
  ])
  return {
    departments: check(departments),
    teams: check(teams),
    people: check(people),
    identities: check(identities),
    apiKeys: check(apiKeys),
  }
}

const PAGE = 1000

/**
 * Read cost_records in a time window, paging past PostgREST's row cap.
 * `jsonPathNotNull` (e.g. "metadata->attribution->>person_email") narrows to
 * rows where that attribution field is set.
 */
export async function loadCostRecords(
  admin: SupabaseClient,
  opts: { start: string; end?: string; jsonPathNotNull?: string }
): Promise<ObservedRecord[]> {
  const out: ObservedRecord[] = []
  for (let from = 0; ; from += PAGE) {
    let q = admin
      .from("cost_records")
      .select("id, provider_id, timestamp, cost_usd, metadata")
      .gte("timestamp", opts.start)
    if (opts.end) q = q.lt("timestamp", opts.end)
    if (opts.jsonPathNotNull) q = q.not(opts.jsonPathNotNull, "is", null)
    const { data, error } = await q.order("id").range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as ObservedRecord[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

export function daysAgo(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

export function notFound(what: string): never {
  throw new HttpError(404, `${what} not found`)
}
