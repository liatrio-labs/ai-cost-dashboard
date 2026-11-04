/**
 * Per-person seat assignments for seat-based manual tools (issue #26).
 *
 * GET /api/admin/seat-assignments
 *   -> { providers: [{ id, name, display_name }], groups: SeatGroup[], people: [{ id, email, display_name }] }
 *   Seat-based providers, every month of seat entries they have (split or
 *   not), and the people directory for the picker.
 *
 * PUT /api/admin/seat-assignments
 *   { provider_id, month: "YYYY-MM", expected_total_usd?, assignments: [{ person_email, seats, cost_usd? }] }
 *   Replaces the month's rows with one row per person plus an org remainder
 *   (lib/org/seat-assignments.ts), atomically through replace_seat_group()
 *   (migration 016). The month's total never changes. An empty assignments
 *   list collapses the month back to one plain entry. Emails not in `people`
 *   are added (no team) so the spend shows in the People table.
 *
 * Errors: 404 unknown provider or no seat entry for the month; 400 non-seat
 * provider, malformed input, or assignments that exceed the month's seats or
 * total; 409 expected_total_usd differs from the month's current total.
 * Admin only (adminRoute).
 */

import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { newPersonDisplayName } from "@/lib/org/display-name"
import { adminRoute, HttpError, json, must, parseBody } from "@/lib/org/admin/http"
import { refreshRollups } from "@/lib/org/admin/repo"
import {
  groupSeatEntries,
  isSeatEntry,
  isSeatProvider,
  MANUAL_METHODS,
  planSeatSplit,
  SeatPlanError,
  SEAT_ENTRY_TYPE,
  entryMonth,
  type SeatEntryRow,
} from "@/lib/org/seat-assignments"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ROW_COLUMNS = "id, user_id, provider_id, timestamp, model_name, cost_usd, request_count, collection_method, metadata"

interface ProviderRow {
  id: string
  name: string
  display_name: string
  metadata: Record<string, unknown> | null
}

async function seatProviders(admin: SupabaseClient): Promise<ProviderRow[]> {
  const rows = must(
    await admin.from("providers").select("id, name, display_name, metadata").eq("is_active", true).order("display_name")
  ) as ProviderRow[]
  return (rows ?? []).filter(isSeatProvider)
}

/** PostgREST returns at most this many rows per request (Supabase default max-rows). */
const PAGE = 1000

/**
 * Every manual seat row for these providers, paged by id. A month seen only
 * in part would be planned from a short total and replace_seat_group would
 * leave the unseen rows behind, so this never stops at one page.
 */
async function seatRows(admin: SupabaseClient, providerIds: string[]): Promise<SeatEntryRow[]> {
  if (!providerIds.length) return []
  const out: SeatEntryRow[] = []
  for (let from = 0; ; from += PAGE) {
    const page = must(
      await admin
        .from("cost_records")
        .select(ROW_COLUMNS)
        .in("provider_id", providerIds)
        .in("collection_method", [...MANUAL_METHODS])
        .eq("metadata->>entry_type", SEAT_ENTRY_TYPE)
        .order("id")
        .range(from, from + PAGE - 1)
    ) as SeatEntryRow[]
    out.push(...(page ?? []))
    if (!page || page.length < PAGE) break
  }
  return out.filter(isSeatEntry)
}

export const GET = adminRoute(async (_request, _params, admin) => {
  const providers = await seatProviders(admin)
  const [rows, people] = await Promise.all([
    seatRows(admin, providers.map((p) => p.id)),
    admin.from("people").select("id, email, display_name").order("email").then(must),
  ])
  return json({
    providers: providers.map(({ id, name, display_name }) => ({ id, name, display_name })),
    groups: groupSeatEntries(rows),
    people: people ?? [],
  })
})

const putSchema = z.object({
  provider_id: z.string().min(1, "provider_id is required"),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"),
  expected_total_usd: z.number().finite().optional(),
  assignments: z
    .array(
      z.object({
        person_email: z.string().trim().min(1, "person_email is required").max(320),
        seats: z.number().int("seats must be a whole number").min(1, "seats must be >= 1"),
        cost_usd: z.number().finite().min(0, "cost_usd must be >= 0").nullable().optional(),
      })
    )
    .max(500),
})

export const PUT = adminRoute(async (request, _params, admin) => {
  const body = await parseBody(request, putSchema)

  const provider = must(
    await admin.from("providers").select("id, name, display_name, metadata").eq("id", body.provider_id).maybeSingle()
  ) as ProviderRow | null
  if (!provider) throw new HttpError(404, "Unknown provider")
  if (!isSeatProvider(provider)) throw new HttpError(400, `${provider.display_name} is not a seat-based tool`)

  const rows = (await seatRows(admin, [provider.id])).filter((r) => entryMonth(r) === body.month)
  const group = groupSeatEntries(rows)[0]
  if (!group) throw new HttpError(404, `No ${provider.display_name} seat entry for ${body.month}`)
  if (body.expected_total_usd !== undefined && Math.abs(body.expected_total_usd - group.total_usd) > 0.005) {
    throw new HttpError(
      409,
      `Totals don't reconcile: ${body.month} now totals $${group.total_usd.toFixed(2)}, not $${body.expected_total_usd.toFixed(2)}. Reload and try again.`
    )
  }

  let plan
  try {
    const first = rows.find((r) => r.id === group.row_ids[0])
    plan = planSeatSplit(group, body.assignments, { newGroupId: randomUUID, baseMetadata: first?.metadata })
  } catch (e) {
    if (e instanceof SeatPlanError) throw new HttpError(e.status, e.message)
    throw e
  }

  // Unknown emails become people (no team) so the spend lands on a person.
  const emails = plan.assignments.map((a) => a.person_email)
  if (emails.length) {
    const known = new Set(
      ((must(await admin.from("people").select("email").in("email", emails)) as { email: string }[]) ?? []).map(
        (p) => p.email
      )
    )
    const missing = emails.filter((e) => !known.has(e))
    if (missing.length) {
      must(await admin.from("people").insert(missing.map((email) => ({ email, display_name: newPersonDisplayName(null, email), team_id: null, active: true }))))
    }
  }

  must(await admin.rpc("replace_seat_group", { p_delete_ids: group.row_ids, p_rows: plan.rows }))
  await refreshRollups()

  return json({
    provider_id: provider.id,
    month: body.month,
    seat_group_id: plan.seat_group_id,
    total_usd: group.total_usd,
    total_seats: group.total_seats,
    price_per_seat: group.price_per_seat,
    assignments: plan.assignments,
    remainder: plan.remainder,
    rows_written: plan.rows.length,
  })
})
