/**
 * Vercel billing/usage data collector.
 *
 * Collects team billing COST data from the Vercel REST API:
 * - GET https://api.vercel.com/v1/billing/charges
 *   https://vercel.com/docs/rest-api/billing/list-focus-billing-charges
 *
 * Unlike Anthropic's cost_report (which returns clean per-model USD), Vercel
 * returns billing data in the open FOCUS v1.3 standard, streamed as
 * newline-delimited JSON (JSONL). Each line is one charge record. This endpoint
 * exposes real dollar amounts (``BilledCost`` / ``EffectiveCost`` in
 * ``BillingCurrency`` = USD), so ``cost_usd`` carries the actual billed cost and
 * ``metadata.cost_known`` is true.
 *
 * Request details:
 * - Auth: ``Authorization: Bearer <token>`` (HTTP bearer).
 * - Query params: ``from`` (required, ISO 8601 UTC), ``to`` (required, ISO 8601
 *   UTC), ``teamId`` (optional, team scoping).
 * - Response: ``application/jsonl`` (one JSON object per line); parsed
 *   defensively line-by-line.
 *
 * Ported from python-service/app/collectors/vercel_collector.py — the
 * transform() logic mirrors transform_to_cost_records exactly.
 */

import type {
  Collector,
  CostRecord,
  CollectorContext,
  CollectOptions,
} from "./types"
import { fetchWithRetry, toFloat, rfc3339 } from "./http"

const BASE_URL = "https://api.vercel.com"
const BILLING_CHARGES_ENDPOINT = "/v1/billing/charges"

/**
 * Parse a JSONL (newline-delimited JSON) body into a list of objects.
 *
 * Defensive: skips blank lines and any line that fails to parse rather than
 * aborting the whole batch. Mirrors the Python _parse_jsonl helper.
 */
export function parseJsonl(body: string): any[] {
  const records: any[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      // Skip unparseable line (matches Python behavior).
      continue
    }
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      records.push(obj)
    }
  }
  return records
}

/**
 * Parse a FOCUS timestamp string into a tz-aware ISO 8601 string, or null if it
 * cannot be parsed. Mirrors the Python timestamp handling.
 */
function parseTs(value: unknown): string | null {
  if (!value || typeof value !== "string") return null
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

/**
 * Transform Vercel FOCUS billing charges into cost_records rows.
 *
 * Each FOCUS charge line becomes one cost record. Real USD cost is taken from
 * ``BilledCost`` (falling back to ``EffectiveCost``); ``metadata.cost_known`` is
 * true for records where a numeric cost was present, false otherwise (cost 0).
 */
export function transform(
  charges: any[],
  ctx: { userId: string; providerId: string; teamId?: string }
): CostRecord[] {
  const records: CostRecord[] = []

  for (const charge of charges || []) {
    if (charge === null || typeof charge !== "object" || Array.isArray(charge)) {
      continue
    }

    // --- Cost (real USD) ----------------------------------------------------
    let billed = charge.BilledCost
    if (billed === undefined || billed === null) {
      billed = charge.EffectiveCost
    }

    const costKnown = typeof billed === "number" && Number.isFinite(billed)
    const cost_usd = costKnown ? toFloat(billed) : 0

    // Skip zero-cost usage line items (no billed cost) — they're noise on a
    // cost dashboard. Keep nonzero charges and credits.
    if (cost_usd === 0) continue

    // --- Timestamp (use the charge period start) ----------------------------
    const rawTs = charge.ChargePeriodStart ?? charge.ChargePeriodEnd
    const timestamp = parseTs(rawTs) ?? new Date().toISOString()

    // --- model_name (NEVER null) --------------------------------------------
    // Use the FOCUS ServiceName as the closest analog to a "model"; fall back
    // to ServiceCategory, then the literal "vercel".
    let modelName = charge.ServiceName || charge.ServiceCategory || "vercel"
    if (typeof modelName !== "string" || !modelName) {
      modelName = "vercel"
    }

    // --- Usage quantity (for metadata) --------------------------------------
    let quantity = charge.ConsumedQuantity
    if (quantity === undefined || quantity === null) {
      quantity = charge.PricingQuantity ?? null
    }
    const unit = charge.ConsumedUnit ?? charge.PricingUnit ?? null

    // Pull project info out of FOCUS Tags when present.
    const tags =
      charge.Tags !== null &&
      typeof charge.Tags === "object" &&
      !Array.isArray(charge.Tags)
        ? charge.Tags
        : {}

    records.push({
      user_id: ctx.userId,
      provider_id: ctx.providerId,
      timestamp,
      model_name: modelName,
      cost_usd,
      tokens_used: null,
      input_tokens: null,
      output_tokens: null,
      request_count: 1,
      collection_method: "api_automated",
      metadata: {
        provider: "vercel",
        team_id: ctx.teamId ?? null,
        metric: modelName,
        quantity: quantity ?? null,
        unit,
        cost_known: costKnown,
        charge_category: charge.ChargeCategory ?? null,
        service_category: charge.ServiceCategory ?? null,
        billing_currency: charge.BillingCurrency ?? null,
        effective_cost: charge.EffectiveCost ?? null,
        charge_period_start: charge.ChargePeriodStart ?? null,
        charge_period_end: charge.ChargePeriodEnd ?? null,
        project_id: tags.ProjectId ?? null,
        project_name: tags.ProjectName ?? null,
      },
    })
  }

  return records
}

/**
 * Fetch FOCUS v1.3 billing charges from the Vercel REST API for a time range,
 * parsing the JSONL response into charge objects.
 */
async function fetchBillingCharges(
  apiKey: string,
  startTime: Date,
  endTime: Date,
  teamId?: string
): Promise<any[]> {
  const params = new URLSearchParams({
    from: rfc3339(startTime),
    to: rfc3339(endTime),
  })
  if (teamId) params.set("teamId", teamId)

  const url = `${BASE_URL}${BILLING_CHARGES_ENDPOINT}?${params.toString()}`
  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/jsonl",
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(
      `Vercel billing API request failed: ${res.status} ${BILLING_CHARGES_ENDPOINT} - ${body}`
    )
  }

  const text = await res.text()
  return parseJsonl(text)
}

/**
 * Collect billing/usage cost data from the Vercel REST API. Defaults to the
 * last 24h, or the last 90 days when opts.backfill is set. Fetches the FOCUS
 * JSONL charges, parses them, then maps via transform().
 */
async function collect(
  ctx: CollectorContext,
  opts: CollectOptions = {}
): Promise<CostRecord[]> {
  const endTime = new Date()
  const days = opts.backfill ? opts.backfillDays ?? 90 : 1
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000)

  const charges = await fetchBillingCharges(
    ctx.apiKey,
    startTime,
    endTime,
    ctx.teamId
  )

  return transform(charges, {
    userId: ctx.userId,
    providerId: ctx.providerId,
    teamId: ctx.teamId,
  })
}

export const collector: Collector = { provider: "vercel", collect }
