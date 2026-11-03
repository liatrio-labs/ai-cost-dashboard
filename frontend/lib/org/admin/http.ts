/**
 * Shared plumbing for the /api/admin/org/* route handlers: the requireAdmin
 * gate, the service-role client, and one error -> HTTP status mapping.
 */

import { NextResponse, type NextRequest } from "next/server"
import { cookies } from "next/headers"
import type { SupabaseClient } from "@supabase/supabase-js"
import { ZodError, type ZodType } from "zod"
import { requireAdmin } from "@/lib/db"
import { createAdminClient } from "@/lib/supabase/admin"

/** An error that maps straight to an HTTP status and JSON body. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = "HttpError"
  }
}

/** A PostgREST error ({ code, message }) thrown from a failed query. */
export class DbError extends Error {
  constructor(public code: string | undefined, message: string) {
    super(message)
    this.name = "DbError"
  }
}

export function json<T>(data: T, status = 200) {
  return NextResponse.json(data, { status })
}

export function toErrorResponse(e: unknown) {
  if (e instanceof Error && e.message === "Unauthorized") return json({ error: "Unauthorized" }, 401)
  if (e instanceof Error && e.message === "Forbidden") return json({ error: "Forbidden" }, 403)
  if (e instanceof HttpError) return json({ error: e.message, ...e.details }, e.status)
  if (e instanceof ZodError) {
    return json(
      {
        error: e.issues[0]?.message ?? "Invalid input",
        issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400
    )
  }
  if (e instanceof DbError) {
    // 23505 unique_violation, 23503 foreign_key_violation, 23514 check_violation
    if (e.code === "23505") return json({ error: "That already exists", detail: e.message }, 409)
    if (e.code === "23503") return json({ error: "Referenced record does not exist", detail: e.message }, 400)
    if (e.code === "23514") return json({ error: "Value not allowed", detail: e.message }, 400)
    return json({ error: e.message || "Database error" }, 500)
  }
  console.error("admin/org route failed:", e instanceof Error ? e.message : e)
  return json({ error: e instanceof Error && e.message ? e.message : "Request failed" }, 500)
}

/** Throw on a PostgREST error, else return data. */
export function must<T>(res: { data: T | null; error: { code?: string; message: string } | null }): T {
  if (res.error) throw new DbError(res.error.code, res.error.message)
  return res.data as T
}

export async function readJson(request: NextRequest): Promise<unknown> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, "Body must be valid JSON")
  }
}

export async function parseBody<T>(request: NextRequest, schema: ZodType<T>): Promise<T> {
  return schema.parse(await readJson(request))
}

export type RouteParams = Record<string, string>

/**
 * Wrap a handler with requireAdmin (401 / 403) and error mapping, and hand it
 * the service-role client. Writes bypass RLS, so every org route goes through here.
 */
export function adminRoute<P extends RouteParams = RouteParams>(
  handler: (request: NextRequest, params: P, admin: SupabaseClient) => Promise<Response>
) {
  return async (request: NextRequest, context: { params: Promise<P> }): Promise<Response> => {
    try {
      const cookieStore = await cookies()
      await requireAdmin(cookieStore)
      const params = ((await context?.params) ?? {}) as P
      return await handler(request, params, createAdminClient())
    } catch (e) {
      return toErrorResponse(e)
    }
  }
}

/** `?confirm=true` (or 1 / yes) on destructive requests. */
export function isConfirmed(request: NextRequest): boolean {
  const v = request.nextUrl.searchParams.get("confirm")
  return v === "true" || v === "1" || v === "yes"
}
