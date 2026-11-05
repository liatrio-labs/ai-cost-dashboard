/**
 * Invoice actuals per provider + calendar month (issue #75). Admin only
 * (requireAdmin); writes use the service-role client.
 *
 * GET  /api/admin/invoice-overrides
 *   -> { available, notice, currentMonth, overrides: InvoiceOverrideView[] }
 *   available is false (notice set, overrides empty) while migration 024
 *   isn't applied.
 * GET  /api/admin/invoice-overrides?provider_id=&month=YYYY-MM
 *   -> { available, notice, currentMonth, overrides, preview: ProviderMonthValues }
 *   preview is the provider-month's API / manual / recurring value, shown
 *   next to the invoiced amount before saving.
 *
 * POST /api/admin/invoice-overrides
 *   { provider_id, month: "YYYY-MM", billed_amount_usd, credits_usd?, notes?, invoice_ids? }
 *   set (or replace) the invoice actual. Complete months only.
 * DELETE /api/admin/invoice-overrides?provider_id=&month=YYYY-MM
 *   clear it: the month goes back to API + manual + recurring.
 *   Both -> the GET body.
 *
 * Errors: 400 malformed input, 404 unknown provider, 503 migration 024 not applied.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { requireAdmin } from "@/lib/db"
import { createAdminClient } from "@/lib/supabase/admin"
import { HttpError, json, must, readJson, toErrorResponse } from "@/lib/org/admin/http"
import {
  clearInvoiceOverride,
  listInvoiceOverrides,
  providerMonthValues,
  setInvoiceOverride,
} from "@/lib/invoice-overrides-admin"
import { InvoiceInputError, parseInvoiceOverrideInput } from "@/lib/invoice-overrides"
import { currentMonthOf, isMonth } from "@/lib/recurring-costs"
import type { SupabaseClient } from "@supabase/supabase-js"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function body(admin: SupabaseClient) {
  return { ...(await listInvoiceOverrides(admin)), currentMonth: currentMonthOf(new Date()) }
}

async function assertProvider(admin: SupabaseClient, providerId: string) {
  const provider = must(await admin.from("providers").select("id").eq("id", providerId).maybeSingle())
  if (!provider) throw new HttpError(404, "Unknown provider")
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(await cookies())
    const admin = createAdminClient()
    const sp = request.nextUrl.searchParams
    const providerId = sp.get("provider_id")
    const month = sp.get("month")
    const out = await body(admin)
    if (!providerId || !month) return json(out)
    if (!isMonth(month)) throw new HttpError(400, "month must be YYYY-MM")
    const [preview] = await providerMonthValues(admin, [{ provider_id: providerId, month }])
    return json({ ...out, preview })
  } catch (e) {
    return toErrorResponse(e)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAdmin(await cookies())
    let input
    try {
      input = parseInvoiceOverrideInput(await readJson(request), currentMonthOf(new Date()))
    } catch (e) {
      if (e instanceof InvoiceInputError) throw new HttpError(400, e.message)
      throw e
    }
    const admin = createAdminClient()
    await assertProvider(admin, input.provider_id)
    await setInvoiceOverride(admin, input, user.email)
    return json(await body(admin))
  } catch (e) {
    return toErrorResponse(e)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireAdmin(await cookies())
    const sp = request.nextUrl.searchParams
    const providerId = sp.get("provider_id")?.trim()
    const month = sp.get("month")
    if (!providerId) throw new HttpError(400, "provider_id is required")
    if (!isMonth(month)) throw new HttpError(400, "month must be YYYY-MM")
    const admin = createAdminClient()
    await clearInvoiceOverride(admin, providerId, month)
    return json(await body(admin))
  } catch (e) {
    return toErrorResponse(e)
  }
}
