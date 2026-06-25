/**
 * Owner-only management of MANUAL cost entries.
 *
 * GET    /api/admin/entries           — list recent manual entries (+provider)
 * PATCH  /api/admin/entries           — update one: { id, cost_usd?, seats?,
 *                                        price_per_seat?, note? } (seats×price
 *                                        recomputes cost_usd)
 * DELETE /api/admin/entries?id=<id>   — delete one
 *
 * Scoped to manual rows only (collection_method in manual_entry/csv_import) so
 * API-collected data can't be edited here. Mutations refresh the dashboard rollup.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { requireAdmin, errorResponse, successResponse } from "@/lib/db"
import { createAdminClient, refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MANUAL_METHODS = ["manual_entry", "csv_import"]

export async function GET() {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)
    const admin = createAdminClient()
    const { data, error } = await admin
      .from("cost_records")
      .select("id, provider_id, timestamp, cost_usd, model_name, collection_method, metadata, providers(display_name, name)")
      .in("collection_method", MANUAL_METHODS)
      .order("timestamp", { ascending: false })
      .limit(200)
    if (error) throw error
    const rows = (data || []).map((r: any) => ({
      id: r.id,
      provider_id: r.provider_id,
      provider_name: r.providers?.display_name || r.providers?.name || "—",
      timestamp: r.timestamp,
      month: (r.metadata?.month as string) || String(r.timestamp).slice(0, 7),
      cost_usd: r.cost_usd,
      model_name: r.model_name,
      entry_type: r.metadata?.entry_type || "monthly_manual",
      seats: r.metadata?.seats ?? null,
      price_per_seat: r.metadata?.price_per_seat ?? null,
      note: r.metadata?.notes || "",
      collection_method: r.collection_method,
    }))
    return successResponse(rows)
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    return errorResponse(e?.message || "Failed to list entries", 500)
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)

    const body = await request.json().catch(() => ({}))
    const id = String(body.id || "")
    if (!id) return errorResponse("id is required", 400)

    const admin = createAdminClient()
    const { data: existing, error: getErr } = await admin
      .from("cost_records")
      .select("id, cost_usd, collection_method, metadata")
      .eq("id", id)
      .single()
    if (getErr || !existing) return errorResponse("Entry not found", 404)
    if (!MANUAL_METHODS.includes((existing as any).collection_method)) {
      return errorResponse("Only manual entries can be edited", 400)
    }

    const meta = { ...((existing as any).metadata || {}) }
    let cost = (existing as any).cost_usd as number

    // Seat-based: recompute cost from seats × price.
    const hasSeats = body.seats !== undefined && body.price_per_seat !== undefined
    if (hasSeats) {
      const seats = Number(body.seats)
      const price = Number(body.price_per_seat)
      if (!Number.isFinite(seats) || seats <= 0 || !Number.isFinite(price) || price <= 0) {
        return errorResponse("seats and price_per_seat must be > 0", 400)
      }
      cost = seats * price
      meta.seats = seats
      meta.price_per_seat = price
      meta.entry_type = "monthly_seats"
      meta.cost_basis = "seat_subscription"
    } else if (body.cost_usd !== undefined) {
      const c = Number(body.cost_usd)
      if (!Number.isFinite(c) || c <= 0) return errorResponse("cost_usd must be > 0", 400)
      cost = c
    }
    if (body.note !== undefined) meta.notes = String(body.note)

    const update: Record<string, unknown> = { cost_usd: cost, metadata: meta }
    if (hasSeats) update.request_count = Math.max(1, Math.round(Number(body.seats)))

    const { data, error } = await admin
      .from("cost_records")
      .update(update as any)
      .eq("id", id)
      .select("id, cost_usd, metadata")
      .single()
    if (error) throw error

    await refreshDailyAggregates()
    return successResponse({ message: "Entry updated", entry: data })
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    return errorResponse(e?.message || "Failed to update entry", 500)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)

    const id = request.nextUrl.searchParams.get("id")
    if (!id) return errorResponse("id query parameter is required", 400)

    const admin = createAdminClient()
    const { data: existing, error: getErr } = await admin
      .from("cost_records")
      .select("id, collection_method")
      .eq("id", id)
      .single()
    if (getErr || !existing) return errorResponse("Entry not found", 404)
    if (!MANUAL_METHODS.includes((existing as any).collection_method)) {
      return errorResponse("Only manual entries can be deleted here", 400)
    }

    const { error } = await admin.from("cost_records").delete().eq("id", id)
    if (error) throw error

    await refreshDailyAggregates()
    return successResponse({ message: "Entry deleted" })
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    return errorResponse(e?.message || "Failed to delete entry", 500)
  }
}
