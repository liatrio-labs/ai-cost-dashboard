/**
 * Owner-only provider (tool) management.
 *
 * GET  /api/admin/providers           — list active providers
 * POST /api/admin/providers           — create a new tool/provider
 *      { display_name, slug?, seat_based?, notes? }
 *
 * Used by the admin page to register new tools (typically manual / seat-based
 * subscriptions that have no collection API). New providers immediately show up
 * in the manual-entry dropdown and, once they have cost rows, on the dashboard.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { requireAdmin, errorResponse, successResponse } from "@/lib/db"
import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Slugify a display name into a stable provider `name` key. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export async function GET() {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)
    const admin = createAdminClient()
    const { data, error } = await admin
      .from("providers")
      .select("id, name, display_name, metadata, is_active")
      .eq("is_active", true)
      .order("display_name")
    if (error) throw error
    return successResponse(data || [])
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    return errorResponse(e?.message || "Failed to list providers", 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)

    const body = await request.json().catch(() => ({}))
    const displayName = String(body.display_name || "").trim()
    if (!displayName) return errorResponse("display_name is required", 400)

    const slug = slugify(body.slug ? String(body.slug) : displayName)
    if (!slug) return errorResponse("Could not derive a valid slug from the name", 400)

    const seatBased = !!body.seat_based
    const admin = createAdminClient()

    // Reject duplicates up front for a clean error (the unique index would 23505).
    const { data: existing } = await admin
      .from("providers")
      .select("id")
      .eq("name", slug)
      .maybeSingle()
    if (existing) return errorResponse(`A tool with slug "${slug}" already exists`, 409)

    const { data, error } = await admin
      .from("providers")
      .insert({
        name: slug,
        display_name: displayName,
        metadata: {
          collection_method: "manual",
          cost_basis: seatBased ? "seat_subscription" : "manual",
          billing: seatBased ? "seat" : "manual",
          source: "admin_ui",
          notes: body.notes ? String(body.notes) : undefined,
        },
      } as any)
      .select("id, name, display_name, metadata")
      .single()
    if (error) throw error

    return successResponse({ message: "Tool created", provider: data }, 201)
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    return errorResponse(e?.message || "Failed to create tool", 500)
  }
}
