/**
 * Providers API Route
 *
 * GET /api/providers — list active providers (id, slug, display name, metadata).
 * Used by the dashboard entry forms and the ChatGPT import page to populate
 * provider pickers. Tool CRUD lives under /api/admin/providers.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(_request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAuth(cookieStore)

    const supabase = await createClient(cookieStore)

    const { data: providers, error } = await supabase
      .from("providers")
      .select("*")
      .eq("is_active", true)
      .order("display_name")

    if (error) throw error

    return successResponse(providers || [])
  } catch (error: any) {
    console.error("GET /api/providers error:", error)

    if (error.message === "Unauthorized") {
      return errorResponse("Unauthorized", 401)
    }

    return errorResponse(error.message || "Failed to fetch providers", 500)
  }
}
