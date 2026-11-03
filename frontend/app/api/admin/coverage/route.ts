/**
 * Provider-day coverage check (#21). Admin only, read-only.
 *
 * GET /api/admin/coverage?provider=<name>&days=<1..90>
 *   provider  optional providers.name (e.g. "anthropic"); default all providers
 *   days      complete UTC days to check, ending yesterday; default 7
 *
 * -> { asOf, window: { start, end, days }, trailingWindow, fraction,
 *      gaps: [{ provider, date, reason: "missing" | "low", total, median, threshold }] }
 *
 * Reads cost_records_daily (all collection methods, summed per provider/day)
 * with the service-role client and runs the pure findCoverageGaps helper
 * (lib/collectors/coverage.ts). The view is refreshed after each collection,
 * so results reflect the last refresh.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { adminRoute, HttpError, json, must } from "@/lib/org/admin/http"
import { COVERAGE_DEFAULTS, coverageWindow, findCoverageGaps, type DailyTotal } from "@/lib/collectors/coverage"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_DAYS = 90
const PAGE = 1000

interface DailyRow {
  provider_id: string
  date: string
  total_cost_usd: number | string | null
}

async function readDaily(
  admin: SupabaseClient,
  start: string,
  endExclusive: string,
  providerId: string | null
): Promise<DailyRow[]> {
  const out: DailyRow[] = []
  for (let from = 0; ; from += PAGE) {
    let q = admin
      .from("cost_records_daily")
      .select("provider_id, date, total_cost_usd")
      .gte("date", start)
      .lt("date", endExclusive)
    if (providerId) q = q.eq("provider_id", providerId)
    const rows = must(
      await q
        .order("date", { ascending: true })
        .order("provider_id", { ascending: true })
        .order("model_name", { ascending: true })
        .order("user_id", { ascending: true })
        .range(from, from + PAGE - 1)
    ) as DailyRow[] | null
    out.push(...(rows ?? []))
    if (!rows || rows.length < PAGE) break
  }
  return out
}

export const GET = adminRoute(async (request, _params, admin) => {
  const sp = request.nextUrl.searchParams
  const daysRaw = sp.get("days")
  const days = daysRaw === null ? COVERAGE_DEFAULTS.lookbackDays : Number(daysRaw)
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new HttpError(400, `days must be an integer between 1 and ${MAX_DAYS}`)
  }

  const providers = (must(await admin.from("providers").select("id, name")) ?? []) as { id: string; name: string }[]
  const providerName = sp.get("provider")?.trim() || null
  let providerId: string | null = null
  if (providerName) {
    const match = providers.find((p) => p.name === providerName)
    if (!match) throw new HttpError(400, `Unknown provider '${providerName}'`)
    providerId = match.id
  }

  const asOf = new Date()
  const window = coverageWindow(days, asOf)
  const trailingWindow = COVERAGE_DEFAULTS.trailingWindow
  const historyStart = new Date(Date.parse(`${window[0]}T00:00:00Z`) - trailingWindow * 86400000)
    .toISOString()
    .slice(0, 10)
  const today = asOf.toISOString().slice(0, 10)

  const nameById = new Map(providers.map((p) => [p.id, p.name]))
  const rows = await readDaily(admin, historyStart, today, providerId)
  const totals: DailyTotal[] = rows.map((r) => ({
    provider: nameById.get(r.provider_id) ?? r.provider_id,
    date: String(r.date).slice(0, 10),
    total: Number(r.total_cost_usd) || 0,
  }))

  return json({
    asOf: asOf.toISOString(),
    window: { start: window[0], end: window[window.length - 1], days },
    trailingWindow,
    fraction: COVERAGE_DEFAULTS.fraction,
    gaps: findCoverageGaps(totals, { lookbackDays: days, trailingWindow, asOf }),
  })
})
