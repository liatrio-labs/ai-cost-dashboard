/**
 * Server-side reads and writes for invoice actuals (issue #75). Service-role
 * client only; callers are behind requireAdmin. Nothing here touches
 * cost_records: overrides are applied at read time (lib/invoice-overrides.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { HttpError } from "@/lib/org/admin/http"
import {
  fetchInvoiceOverrides,
  fetchManualRows,
  fetchProviderMonthRollup,
  fetchRecurringCosts,
  type SupabaseLike,
} from "@/lib/dashboard-data"
import {
  INVOICE_OVERRIDE_COLUMNS,
  MIGRATION_024_NOTICE,
  buildInvoicePlan,
  isMissingInvoiceTable,
  monthKey,
  type InvoiceOverride,
  type InvoiceOverrideInput,
} from "@/lib/invoice-overrides"
import { manualMonthKeys, segmentFor } from "@/lib/recurring-costs"

const round2 = (n: number) => Math.round(n * 100) / 100

/** What a provider-month counts without an override, next to the invoice. */
export interface ProviderMonthValues {
  provider_id: string
  /** YYYY-MM */
  month: string
  /** API-collected spend (rollup minus manual entries). */
  api_usd: number
  /** Manual entries for the month (replaced by an override). */
  manual_usd: number
  /** Recurring cost counted for the month (replaced by an override). */
  recurring_usd: number
  /** api + manual + recurring: the dashboard value without an override. */
  without_override_usd: number
}

/** API / manual / recurring values for provider-months, as the dashboard counts them without an override. */
export async function providerMonthValues(
  admin: SupabaseClient,
  months: { provider_id: string; month: string }[]
): Promise<ProviderMonthValues[]> {
  if (!months.length) return []
  const db = admin as unknown as SupabaseLike
  const providerIds = [...new Set(months.map((m) => m.provider_id))]
  const [basis, manualRows, recurring] = await Promise.all([
    Promise.all(months.map((m) => fetchProviderMonthRollup(db, m.provider_id, m.month))),
    fetchManualRows(db, providerIds),
    fetchRecurringCosts(db),
  ])
  // A plan with a 0 invoice per month just to split rollup into API vs manual.
  const plan = buildInvoicePlan({
    overrides: months.map((m) => ({ provider_id: m.provider_id, month: `${m.month}-01`, billed_amount_usd: 0 })),
    basisRows: basis.flat(),
    manualRows,
  })
  const manualKeys = manualMonthKeys(manualRows)
  return months.map((m) => {
    const p = plan.months.get(monthKey(m.provider_id, m.month))
    const seg = manualKeys.has(monthKey(m.provider_id, m.month)) ? null : segmentFor(recurring, m.provider_id, m.month)
    const api = round2(p?.api_usd ?? 0)
    const manual = round2(p?.manual_usd ?? 0)
    const rec = seg ? round2(Number(seg.monthly_cost_usd) || 0) : 0
    return { ...m, api_usd: api, manual_usd: manual, recurring_usd: rec, without_override_usd: round2(api + manual + rec) }
  })
}

export type InvoiceOverrideView = InvoiceOverride & ProviderMonthValues & { billed_amount_usd: number; delta_usd: number }

/** Every override with its API value; available false (no rows) without migration 024. */
export async function listInvoiceOverrides(
  admin: SupabaseClient
): Promise<{ available: boolean; notice: string | null; overrides: InvoiceOverrideView[] }> {
  const { available, overrides } = await fetchInvoiceOverrides(admin as unknown as SupabaseLike).catch((e: { message?: string }) => {
    throw new HttpError(500, e?.message || "Failed to load invoice actuals")
  })
  if (!available) return { available: false, notice: MIGRATION_024_NOTICE, overrides: [] }
  const values = await providerMonthValues(
    admin,
    overrides.map((o) => ({ provider_id: o.provider_id, month: String(o.month).slice(0, 7) }))
  )
  const views = overrides
    .map((o, i) => {
      const billed = round2(Number(o.billed_amount_usd) || 0)
      return {
        ...o,
        ...values[i],
        billed_amount_usd: billed,
        credits_usd: o.credits_usd == null ? null : Number(o.credits_usd),
        delta_usd: round2(billed - values[i].without_override_usd),
      }
    })
    .sort((a, b) => b.month.localeCompare(a.month) || a.provider_id.localeCompare(b.provider_id))
  return { available: true, notice: null, overrides: views }
}

/** Set (insert or replace) the invoice actual for one provider-month. 503 without migration 024. */
export async function setInvoiceOverride(admin: SupabaseClient, input: InvoiceOverrideInput, enteredBy: string): Promise<void> {
  const month = `${input.month}-01`
  const row = {
    billed_amount_usd: input.billed_amount_usd,
    credits_usd: input.credits_usd,
    notes: input.notes,
    invoice_ids: input.invoice_ids,
    entered_by: enteredBy,
    entered_at: new Date().toISOString(),
  }
  const existing = await admin
    .from("invoice_overrides")
    .select(INVOICE_OVERRIDE_COLUMNS)
    .eq("provider_id", input.provider_id)
    .eq("month", month)
  if (existing.error) {
    if (isMissingInvoiceTable(existing.error)) throw new HttpError(503, MIGRATION_024_NOTICE)
    throw new HttpError(500, existing.error.message || "Failed to load invoice actual")
  }
  const res = (existing.data ?? []).length
    ? await admin.from("invoice_overrides").update(row).eq("provider_id", input.provider_id).eq("month", month)
    : await admin.from("invoice_overrides").insert({ provider_id: input.provider_id, month, ...row })
  if (res.error) {
    if (isMissingInvoiceTable(res.error)) throw new HttpError(503, MIGRATION_024_NOTICE)
    throw new HttpError(400, res.error.message || "Failed to save invoice actual")
  }
}

/** Clear one provider-month's invoice actual (no-op when there is none). 503 without migration 024. */
export async function clearInvoiceOverride(admin: SupabaseClient, providerId: string, ym: string): Promise<void> {
  const { error } = await admin.from("invoice_overrides").delete().eq("provider_id", providerId).eq("month", `${ym}-01`)
  if (!error) return
  if (isMissingInvoiceTable(error)) throw new HttpError(503, MIGRATION_024_NOTICE)
  throw new HttpError(400, error.message || "Failed to clear invoice actual")
}
