/**
 * Server-side writes for recurring monthly costs (issue #59). Service-role
 * client only (callers are admin-gated). The one write path is
 * set_recurring_cost() (migration 022), which applies a change from a month
 * onward atomically. Nothing here touches cost_records.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { HttpError } from "@/lib/org/admin/http"
import {
  MIGRATION_022_MESSAGE,
  RECURRING_COLUMNS,
  isMissingRelation,
  type RecurringCost,
  type RecurringInput,
} from "@/lib/recurring-costs"

/** All segments, or available: false when migration 022 isn't applied. */
export async function listRecurringCosts(admin: SupabaseClient): Promise<{ available: boolean; costs: RecurringCost[] }> {
  const { data, error } = await admin.from("recurring_costs").select(RECURRING_COLUMNS).order("start_month")
  if (error) {
    if (isMissingRelation(error)) return { available: false, costs: [] }
    throw new HttpError(500, error.message || "Failed to load recurring costs")
  }
  return { available: true, costs: (data || []) as RecurringCost[] }
}

/**
 * Apply a change (or, with monthly_cost_usd null, an end) from
 * input.from_month onward. 503 without migration 022; 409 on an overlap the
 * trigger refuses; 400 on other refusals.
 */
export async function applyRecurringCost(admin: SupabaseClient, input: RecurringInput, userId: string | null): Promise<void> {
  const { error } = await admin.rpc("set_recurring_cost", {
    p_provider_id: input.provider_id,
    p_from_month: `${input.from_month}-01`,
    p_monthly_cost_usd: input.monthly_cost_usd,
    p_seats: input.seats ?? null,
    p_price_per_seat: input.price_per_seat ?? null,
    p_end_month: input.end_month ? `${input.end_month}-01` : null,
    p_notes: input.notes ?? null,
    p_created_by: userId,
  })
  if (!error) return
  if (isMissingRelation(error)) throw new HttpError(503, MIGRATION_022_MESSAGE)
  if (error.code === "23P01") throw new HttpError(409, error.message)
  throw new HttpError(400, error.message || "Failed to save recurring cost")
}
