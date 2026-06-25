/**
 * Apify usage/billing collector (TypeScript).
 *
 * Apify exposes real USD spend with a per-day, per-service breakdown:
 *
 *   GET https://api.apify.com/v2/users/me/usage/monthly?date=YYYY-MM-DD
 *     Auth: Authorization: Bearer <APIFY_TOKEN>  (requires an account-scoped
 *     personal API token — restricted/scoped tokens get insufficient-permissions).
 *
 *     Returns the usage cycle that CONTAINS `date` (or the current cycle when
 *     omitted). Response shape (verified live 2026-06):
 *       {
 *         usageCycle: { startAt, endAt },
 *         totalUsageCreditsUsdBeforeVolumeDiscount,
 *         totalUsageCreditsUsdAfterVolumeDiscount,
 *         monthlyServiceUsage: { <SERVICE>: { quantity, baseAmountUsd, ... } },
 *         dailyServiceUsages: [
 *           {
 *             date: "2026-06-19T00:00:00.000Z",
 *             serviceUsage: { <SERVICE>: { quantity, baseAmountUsd } },
 *             totalUsageCreditsUsd            // daily $ total
 *           }, ...
 *         ]
 *       }
 *
 * Modeling decision:
 *   One cost record per UTC day, cost_usd = that day's `totalUsageCreditsUsd`,
 *   model_name = "apify", with the per-service `baseAmountUsd` breakdown kept in
 *   metadata. Cycles are billing-aligned (e.g. the 19th-18th), so backfill walks
 *   the `date` param backward one cycle at a time; per-day UTC-midnight
 *   timestamps keep re-pulls idempotent (runner delete-then-insert-by-timestamp).
 */

import type {
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toFloat, startOfUTCDay, DAY_MS, isoDate, sleep } from "./http"

const API_BASE_URL = "https://api.apify.com"
const RATE_LIMIT_DELAY_MS = 250

interface DailyUsage {
  date?: string
  totalUsageCreditsUsd?: number
  serviceUsage?: Record<string, { quantity?: number; baseAmountUsd?: number }>
}

interface MonthlyUsageResponse {
  usageCycle?: { startAt?: string; endAt?: string }
  dailyServiceUsages?: DailyUsage[]
}

interface TransformCtx {
  userId: string
  providerId: string
}

/**
 * Transform Apify daily-usage rows into cost_records, one per UTC day.
 *
 * Pure: no network. Skips rows with an unparseable date. `cycleStart`/`cycleEnd`
 * annotate which billing cycle the day came from.
 */
export function transform(
  dailyRows: DailyUsage[],
  ctx: TransformCtx,
  cycle: { start?: string; end?: string } = {}
): CostRecord[] {
  const records: CostRecord[] = []

  for (const row of dailyRows ?? []) {
    const raw = row?.date
    if (!raw) continue
    const ms = Date.parse(raw)
    if (Number.isNaN(ms)) continue
    const day = startOfUTCDay(new Date(ms)).toISOString()

    const costUsd = toFloat(row?.totalUsageCreditsUsd)

    // Per-service USD breakdown for metadata / reconciliation.
    const services: Record<string, number> = {}
    let serviceCount = 0
    for (const [name, su] of Object.entries(row?.serviceUsage ?? {})) {
      services[name] = toFloat(su?.baseAmountUsd)
      serviceCount += 1
    }

    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp: day,
      model_name: "apify",
      cost_usd: costUsd,
      tokens_used: null,
      input_tokens: null,
      output_tokens: null,
      request_count: serviceCount || 1,
      collection_method: "api_automated",
      metadata: {
        provider: "apify",
        services,
        cycle_start: cycle.start ?? null,
        cycle_end: cycle.end ?? null,
        day: day.slice(0, 10),
      },
    })
  }

  return records
}

async function fetchMonthlyUsage(
  apiKey: string,
  date?: string
): Promise<MonthlyUsageResponse> {
  const url = new URL(`${API_BASE_URL}/v2/users/me/usage/monthly`)
  if (date) url.searchParams.set("date", date)
  const res = await fetchWithRetry(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    throw new Error(
      `Apify usage/monthly request failed: ${res.status} ${await res.text()}`
    )
  }
  const json = (await res.json()) as { data?: MonthlyUsageResponse } & MonthlyUsageResponse
  // Apify wraps most responses in { data: ... }; usage/monthly returns it flat.
  return (json?.data ?? json) as MonthlyUsageResponse
}

async function collect(
  ctx: CollectorContext,
  opts: CollectOptions = {}
): Promise<CostRecord[]> {
  const today = startOfUTCDay(new Date())
  const days = opts.backfill ? opts.backfillDays ?? 90 : 1
  const earliest = today.getTime() - days * DAY_MS

  // Walk billing cycles backward from the current one until we've covered the
  // window. Each call returns the cycle CONTAINING `date`; we step to the day
  // before that cycle's start to reach the previous cycle.
  const byDay = new Map<string, CostRecord>()
  let probe: string | undefined // undefined -> current cycle
  // Hard cap on cycles to avoid runaway loops (covers ~2 years).
  for (let i = 0; i < 30; i++) {
    const resp = await fetchMonthlyUsage(ctx.apiKey, probe)
    const cycle = {
      start: resp?.usageCycle?.startAt,
      end: resp?.usageCycle?.endAt,
    }
    const recs = transform(resp?.dailyServiceUsages ?? [], ctx, cycle)
    for (const r of recs) byDay.set(r.timestamp, r) // de-dupe across cycles

    const cycleStartMs = cycle.start ? Date.parse(cycle.start) : NaN
    if (Number.isNaN(cycleStartMs)) break
    if (cycleStartMs <= earliest) break // covered the requested window
    if (!opts.backfill) break // daily run: current cycle only

    // Probe the day before this cycle's start to land in the previous cycle.
    probe = isoDate(new Date(cycleStartMs - DAY_MS))
    await sleep(RATE_LIMIT_DELAY_MS)
  }

  // Keep only days within the requested window.
  return Array.from(byDay.values()).filter(
    (r) => Date.parse(r.timestamp) >= earliest
  )
}

export const collector: Collector = {
  provider: "apify",
  collect,
}
