/**
 * Owner-only management of MANUAL cost entries.
 *
 * GET    /api/admin/entries           — list recent manual entries (+provider)
 * PATCH  /api/admin/entries           — update one: { id, cost_usd?, seats?,
 *                                        price_per_seat?, note? } (seats×price
 *                                        recomputes cost_usd)
 * DELETE /api/admin/entries?id=<id>   — delete one
 * DELETE /api/admin/entries?seat_group_id=<id> — delete a split seat month
 *                                        (every row of the set, issue #26)
 *
 * Rows of a split seat month (metadata.seat_group_id) can't be edited one by
 * one, since that would break the month's reconciliation; re-assign them in
 * Seat assignments or delete the whole set.
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

type Meta = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
interface EntryDbRow {
  id: string
  provider_id: string
  timestamp: string
  cost_usd: number
  model_name: string
  collection_method: string
  metadata: Meta | null
  providers?: { display_name?: string; name?: string } | null
}

/** Maps requireAdmin's errors to 401/403, anything else to `status`. */
function failure(e: unknown, fallback: string) {
  const message = e instanceof Error ? e.message : ""
  if (message === "Unauthorized") return errorResponse("Unauthorized", 401)
  if (message === "Forbidden") return errorResponse("Forbidden", 403)
  return errorResponse(message || (e as { message?: string })?.message || fallback, 500)
}

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
      .limit(500)
    if (error) throw error
    const rows = ((data || []) as unknown as EntryDbRow[]).map((r) => ({
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
      seat_group_id: r.metadata?.seat_group_id || null,
      person_email:
        r.metadata?.attribution?.granularity === "person" ? r.metadata?.attribution?.person_email || null : null,
      remainder: r.metadata?.remainder === true,
      collection_method: r.collection_method,
    }))
    return successResponse(rows)
  } catch (e) {
    return failure(e, "Failed to list entries")
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
    const row = existing as unknown as EntryDbRow
    if (!MANUAL_METHODS.includes(row.collection_method)) {
      return errorResponse("Only manual entries can be edited", 400)
    }
    if (row.metadata?.seat_group_id) {
      return errorResponse(
        "This entry is part of a split seat month; re-assign it in Seat assignments or delete the whole month",
        400
      )
    }

    const meta: Meta = { ...(row.metadata || {}) }
    let cost = Number(row.cost_usd)

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
      .update(update as never)
      .eq("id", id)
      .select("id, cost_usd, metadata")
      .single()
    if (error) throw error

    await refreshDailyAggregates()
    return successResponse({ message: "Entry updated", entry: data })
  } catch (e) {
    return failure(e, "Failed to update entry")
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)

    const id = request.nextUrl.searchParams.get("id")
    const groupId = request.nextUrl.searchParams.get("seat_group_id")
    if (!id && !groupId) return errorResponse("id or seat_group_id query parameter is required", 400)

    const admin = createAdminClient()
    if (groupId) {
      // One statement, so the whole split month goes at once.
      const { data, error } = await admin
        .from("cost_records")
        .delete()
        .in("collection_method", MANUAL_METHODS)
        .eq("metadata->>seat_group_id", groupId)
        .select("id")
      if (error) throw error
      if (!data || data.length === 0) return errorResponse("Seat group not found", 404)
      await refreshDailyAggregates()
      return successResponse({ message: `Deleted ${data.length} entries`, deleted: data.length })
    }

    const { data: existing, error: getErr } = await admin
      .from("cost_records")
      .select("id, collection_method, metadata")
      .eq("id", id!)
      .single()
    if (getErr || !existing) return errorResponse("Entry not found", 404)
    const row = existing as unknown as EntryDbRow
    if (!MANUAL_METHODS.includes(row.collection_method)) {
      return errorResponse("Only manual entries can be deleted here", 400)
    }
    if (row.metadata?.seat_group_id) {
      return errorResponse("This entry is part of a split seat month; delete the whole month (seat_group_id)", 400)
    }

    const { error } = await admin.from("cost_records").delete().eq("id", id)
    if (error) throw error

    await refreshDailyAggregates()
    return successResponse({ message: "Entry deleted" })
  } catch (e) {
    return failure(e, "Failed to delete entry")
  }
}
