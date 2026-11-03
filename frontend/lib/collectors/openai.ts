/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * OpenAI organization Costs/Usage API collector.
 *
 * Endpoints (Admin key, sk-admin-...):
 * - GET /v1/organization/costs
 *     group_by=line_item,project_id,api_key_id   (USD, daily buckets; authoritative)
 *     If the API rejects api_key_id on /costs (400), we retry with
 *     line_item,project_id so collection never breaks (rows are then
 *     project-level). Each run logs one line saying which grouping was used
 *     ("[openai] costs grouping=api_key" or "grouping=fallback status=400") and
 *     reports it as `costs_grouping` in the collection summary (cron JSON).
 * - GET /v1/organization/usage/completions
 *     group_by=model,project_id,api_key_id,user_id (tokens; joined best-effort)
 * - GET /v1/organization/projects and /projects/{id}/api_keys
 *     best-effort project / key NAME lookup; any failure is ignored.
 *
 * Cost buckets: { start_time, results: [ { amount: {value, currency},
 *   line_item, project_id, api_key_id } ] }.
 * Usage results: { model, project_id, api_key_id, user_id, input_tokens,
 *   output_tokens, num_model_requests }.
 *
 * One record per (day x line_item x project x api key). Tokens attach when a
 * usage model matches the line_item (case-insensitive) for the same project and
 * key; usage is summed across user_id (cost has no user dimension) and the
 * distinct user ids are kept in metadata.usage_user_ids.
 *
 * Daily (non-backfill) pulls re-fetch today plus the prior
 * DEFAULT_LOOKBACK_DAYS (7) UTC days, i.e. [today - 7d, tomorrow): costs keep
 * settling after a day ends and storeRecords() overwrites re-fetched days.
 */

import type { Collector, CostRecord, CollectorContext, CollectOptions } from "./types"
import { fetchWithRetry, toFloat, toInt, isoDate, unixSeconds } from "./http"
import { buildAttribution, str } from "./attribution"

// NOTE: singular "organization".
const API_BASE_URL = "https://api.openai.com/v1/organization"
const MAX_HISTORICAL_DAYS = 366
/** Daily (non-backfill) pull: today plus this many prior UTC days (#21). */
export const DEFAULT_LOOKBACK_DAYS = 7
// Max buckets per page for bucket_width=1d is 31; pagination fetches the rest.
const PAGE_LIMIT = 31
const SEP = "\u0000"

export const COST_GROUP_BY = ["line_item", "project_id", "api_key_id"]
export const COST_GROUP_BY_FALLBACK = ["line_item", "project_id"]
export const USAGE_GROUP_BY = ["model", "project_id", "api_key_id", "user_id"]

/** How /costs was grouped this run: by api key, or the 400 fallback. */
export type CostsGrouping = "api_key" | "fallback"

/** Best-effort id -> name lookups. */
export interface NameLookup {
  projects: Record<string, string>
  apiKeys: Record<string, { name: string | null; owner_email: string | null }>
}

const EMPTY_NAMES: NameLookup = { projects: {}, apiKeys: {} }

interface TransformCtx {
  userId: string
  providerId: string
  organizationId?: string
}

function unixToIso(value: unknown): string | null {
  const n = typeof value === "number" ? value : parseInt(String(value), 10)
  if (!Number.isFinite(n)) return null
  const d = new Date(n * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Transform Costs + Usage buckets into cost_records rows (pure).
 *
 * `costGroupedByKey` says whether /costs was grouped by api_key_id; when it
 * was not (fallback), usage is joined ignoring the key so tokens still attach.
 */
export function transform(
  costBuckets: any[],
  usageBuckets: any[],
  ctx: TransformCtx,
  names: NameLookup = EMPTY_NAMES,
  costGroupedByKey: boolean = true
): CostRecord[] {
  const keyOf = (start: unknown, model: unknown, project: unknown, apiKey: unknown) =>
    [start, String(model ?? "").toLowerCase(), project ?? "", costGroupedByKey ? apiKey ?? "" : ""].join(SEP)

  const usageMap = new Map<string, { input: number; output: number; requests: number; users: Set<string> }>()
  for (const bucket of usageBuckets || []) {
    for (const row of bucket?.results || []) {
      const key = keyOf(bucket?.start_time, row?.model, row?.project_id, row?.api_key_id)
      const agg = usageMap.get(key) ?? { input: 0, output: 0, requests: 0, users: new Set<string>() }
      agg.input += toInt(row?.input_tokens ?? 0)
      agg.output += toInt(row?.output_tokens ?? 0)
      agg.requests += toInt(row?.num_model_requests ?? 0)
      if (row?.user_id) agg.users.add(String(row.user_id))
      usageMap.set(key, agg)
    }
  }

  const records: CostRecord[] = []
  for (const bucket of costBuckets || []) {
    const timestamp = unixToIso(bucket?.start_time)
    if (timestamp === null) continue

    for (const row of bucket?.results || []) {
      const lineItem = row?.line_item || "openai"
      const amount = row?.amount || {}
      const projectId = str(row?.project_id)
      const apiKeyId = str(row?.api_key_id)
      const usage = usageMap.get(keyOf(bucket?.start_time, lineItem, projectId, apiKeyId))
      const keyInfo = apiKeyId ? names.apiKeys[apiKeyId] : undefined

      records.push({
        user_id: ctx.userId,
        provider_id: ctx.providerId,
        timestamp,
        model_name: lineItem,
        cost_usd: toFloat(amount?.value),
        tokens_used: usage ? usage.input + usage.output : null,
        input_tokens: usage ? usage.input : null,
        output_tokens: usage ? usage.output : null,
        request_count: usage?.requests || 1,
        collection_method: "api_automated",
        metadata: {
          provider: "openai",
          line_item: lineItem,
          currency: amount?.currency ?? "usd",
          project_id: projectId,
          organization_id: ctx.organizationId ?? null,
          usage_user_ids: usage ? Array.from(usage.users).sort() : [],
          // Who created the key; a hint for mapping keys to people, not proof
          // of who spent it.
          api_key_owner_email: keyInfo?.owner_email ?? null,
          attribution: buildAttribution({
            api_key_id: apiKeyId,
            api_key_name: keyInfo?.name ?? null,
            project_id: projectId,
            project_name: projectId ? names.projects[projectId] ?? null : null,
          }),
        },
      })
    }
  }
  return records
}

function authHeaders(apiKey: string, organizationId?: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  if (organizationId) headers["OpenAI-Organization"] = organizationId
  return headers
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** Fetch all bucket rows across pages from a Costs/Usage endpoint. */
async function fetchPaginated(
  endpoint: string,
  apiKey: string,
  organizationId: string | undefined,
  startUnix: number,
  endUnix: number,
  groupBy: string[]
): Promise<any[]> {
  const allBuckets: any[] = []
  let page: string | undefined
  while (true) {
    const url = new URL(`${API_BASE_URL}${endpoint}`)
    url.searchParams.set("start_time", String(startUnix))
    url.searchParams.set("end_time", String(endUnix))
    url.searchParams.set("bucket_width", "1d")
    url.searchParams.set("limit", String(PAGE_LIMIT))
    for (const g of groupBy) url.searchParams.append("group_by", g)
    if (page) url.searchParams.set("page", page)

    const res = await fetchWithRetry(url.toString(), { headers: authHeaders(apiKey, organizationId) })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new HttpError(res.status, `OpenAI API request to ${endpoint} failed: ${res.status} ${body}`)
    }
    const json: any = await res.json()
    allBuckets.push(...(json?.data || []))
    page = json?.next_page
    if (!json?.has_more || !page) break
  }
  return allBuckets
}

/** List every item of a cursor-paginated admin list endpoint (limit/after). */
async function listAll(url: string, headers: Record<string, string>): Promise<any[]> {
  const out: any[] = []
  let after: string | undefined
  for (let i = 0; i < 100; i++) {
    const u = new URL(url)
    u.searchParams.set("limit", "100")
    if (after) u.searchParams.set("after", after)
    const res = await fetchWithRetry(u.toString(), { headers })
    if (!res.ok) throw new Error(`${res.status}`)
    const json: any = await res.json()
    const data = json?.data ?? []
    out.push(...data)
    after = json?.last_id ?? data[data.length - 1]?.id
    if (!json?.has_more || !after) break
  }
  return out
}

/**
 * Best-effort project + API key names. Never throws: a failed lookup only
 * leaves names null.
 */
export async function fetchNames(apiKey: string, organizationId?: string): Promise<NameLookup> {
  const names: NameLookup = { projects: {}, apiKeys: {} }
  const headers = authHeaders(apiKey, organizationId)
  let projects: any[]
  try {
    projects = await listAll(`${API_BASE_URL}/projects?include_archived=true`, headers)
  } catch {
    return names
  }
  for (const p of projects) {
    if (p?.id) names.projects[p.id] = p?.name ?? null
  }
  await Promise.all(
    projects
      .filter((p) => p?.id)
      .map(async (p) => {
        try {
          const keys = await listAll(`${API_BASE_URL}/projects/${encodeURIComponent(p.id)}/api_keys`, headers)
          for (const k of keys) {
            if (!k?.id) continue
            names.apiKeys[k.id] = {
              name: str(k?.name),
              owner_email: k?.owner?.user?.email ? String(k.owner.user.email).toLowerCase() : null,
            }
          }
        } catch {
          // ignore: names are optional
        }
      })
  )
  return names
}

/**
 * One structured line per run. Only fixed tokens and the HTTP status: never the
 * key, headers or a response body.
 */
function logCostsGrouping(grouping: CostsGrouping, status?: number): void {
  const groupBy = (grouping === "api_key" ? COST_GROUP_BY : COST_GROUP_BY_FALLBACK).join(",")
  const statusPart = status === undefined ? "" : ` status=${status}`
  console.log(`[openai] costs grouping=${grouping}${statusPart} group_by=${groupBy}`)
}

function isoDateToUnix(isoDay: string): number {
  return unixSeconds(new Date(`${isoDay}T00:00:00.000Z`))
}

async function collect(ctx: CollectorContext, opts: CollectOptions = {}): Promise<CostRecord[]> {
  const endDate = new Date()
  endDate.setUTCHours(0, 0, 0, 0)
  const days = opts.backfill
    ? Math.min(opts.backfillDays ?? MAX_HISTORICAL_DAYS, MAX_HISTORICAL_DAYS)
    : DEFAULT_LOOKBACK_DAYS
  const startDate = new Date(endDate)
  startDate.setUTCDate(startDate.getUTCDate() - days)
  const endPlusOne = new Date(endDate)
  endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1)
  const startUnix = isoDateToUnix(isoDate(startDate))
  const endUnix = isoDateToUnix(isoDate(endPlusOne))

  const fetchCosts = async (): Promise<{ buckets: any[]; byKey: boolean }> => {
    try {
      const buckets = await fetchPaginated("/costs", ctx.apiKey, ctx.organizationId, startUnix, endUnix, COST_GROUP_BY)
      logCostsGrouping("api_key")
      ctx.report?.({ costs_grouping: "api_key" })
      return { buckets, byKey: true }
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400) throw e
      const buckets = await fetchPaginated(
        "/costs",
        ctx.apiKey,
        ctx.organizationId,
        startUnix,
        endUnix,
        COST_GROUP_BY_FALLBACK
      )
      logCostsGrouping("fallback", e.status)
      ctx.report?.({ costs_grouping: "fallback" })
      return { buckets, byKey: false }
    }
  }

  const [costs, usageBuckets, names] = await Promise.all([
    fetchCosts(),
    fetchPaginated("/usage/completions", ctx.apiKey, ctx.organizationId, startUnix, endUnix, USAGE_GROUP_BY),
    fetchNames(ctx.apiKey, ctx.organizationId),
  ])

  return transform(
    costs.buckets,
    usageBuckets,
    { userId: ctx.userId, providerId: ctx.providerId, organizationId: ctx.organizationId },
    names,
    costs.byKey
  )
}

export const collector: Collector = { provider: "openai", collect }
