/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * OpenAI key sync (issue #46), modeled on anthropic-key-sync.ts.
 *
 * Runs best-effort after every openai collection (runner.ts, reported as
 * `key_sync`) and strictly from "Sync keys now"
 * (POST /api/admin/org/keys/sync). With the openai provider's Admin key it
 * lists:
 *
 *   GET /v1/organization/projects?include_archived=true
 *   GET /v1/organization/projects/{id}/api_keys      (owner.user.email)
 *
 * and adds every key seen on the openai cost rows that the API no longer
 * lists (deleted keys), taking their creator from the collector's
 * metadata.api_key_owner_email. Then:
 *
 * - Projects become org_projects (provider openai, external id = project id).
 *   An existing project only gets a missing name filled in.
 * - Every key is upserted into org_api_keys: name, creator id and email,
 *   org_project_id = its project, spend_attribution NULL.
 * - Auto owner: the creator's email (owner.user.email, else
 *   api_key_owner_email) when it matches a person (people.email, else an
 *   openai person_identities row whose external id is that email) ->
 *   owner_person_id, assignment_source 'auto'. Unlike the Anthropic and
 *   gateway syncs no person is created: an email that matches nobody leaves
 *   the key unassigned with unresolved_reason 'unmatched_creator'. Service
 *   accounts get 'service_account', keys with no recorded owner 'no_creator'.
 * - Manual keys (assignment_source 'manual', or an owner / team / project set
 *   before 015) keep their owner, team and project; only metadata refreshes.
 *
 * Attribution precedence is #34's: the person on the cost row (OpenAI rows
 * carry none today) > manual owner > this auto creator owner > the key's
 * project, then its team > Unassigned. The view is unchanged.
 *
 * The project and key lists are strict: a failure throws OpenAIKeySyncError
 * before anything is written. The cost-row supplement is best-effort.
 *
 * No migration is needed: org_api_keys has no provider constraint and 017's
 * unresolved_reason values cover every OpenAI case. Migration 017 is optional
 * at runtime, as in the Anthropic sync.
 *
 * Migration 018 (issue #44, optional): a listed key's created_at (epoch
 * seconds) is stored in provider_created_at. Cost-row-only keys carry no
 * date, so a stored one is kept.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { fetchWithRetry } from "@/lib/collectors/http"
import { normalizeEmail } from "./attribution"
import { planAnthropicKey, type AnthropicKeyRow, type CreatorResolution, type UnresolvedKey } from "./anthropic-key-sync"
import { isManual } from "./gateway-sync"
import { ensureProjects, must, parseProviderTimestamp, selectKeyTier } from "./sync-helpers"

const API_BASE_URL = "https://api.openai.com/v1/organization"
const PAGE_LIMIT = 100
const MAX_PAGES = 100
/** Cost-row scan for "Sync keys now": rows per page and a hard page cap. */
const COST_ROWS_PAGE = 1000
const COST_ROWS_MAX_PAGES = 200

export class OpenAIKeySyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenAIKeySyncError"
  }
}

export interface OpenAIKeyOwner {
  /** "user" | "service_account" | null (unknown) */
  type: string | null
  id: string | null
  email: string | null
  name: string | null
}

export interface OpenAIApiKey {
  id: string
  name: string | null
  project_id: string | null
  owner: OpenAIKeyOwner | null
  /** api = listed by the Admin API; cost_records = seen only on cost rows (e.g. a deleted key). */
  source: "api" | "cost_records"
  /** When OpenAI created the key (ISO, from created_at); null/absent = unknown. */
  created_at?: string | null
}

export interface OpenAIProject {
  id: string
  name: string | null
}

export interface OpenAIKeyListing {
  keys: OpenAIApiKey[]
  /** null when the project list wasn't fetched (cost-row keys only). */
  projects: OpenAIProject[] | null
  /** The cost-row scan failed: deleted keys weren't added. */
  cost_records_unavailable?: boolean
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function headers(adminKey: string, organizationId?: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${adminKey}` }
  if (organizationId) h["OpenAI-Organization"] = organizationId
  return h
}

/** GET a cursor-paginated admin list (limit / after / has_more / last_id). Throws on any non-2xx page. */
async function listAll(url: string, h: Record<string, string>, what: string): Promise<any[]> {
  const out: any[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(url)
    u.searchParams.set("limit", String(PAGE_LIMIT))
    if (after) u.searchParams.set("after", after)
    const res = await fetchWithRetry(u.toString(), { method: "GET", headers: h })
    // Status only: never the body, headers or key.
    if (!res.ok) throw new OpenAIKeySyncError(`OpenAI Admin API ${what} failed: HTTP ${res.status}`)
    const json: any = await res.json()
    const data: any[] = Array.isArray(json?.data) ? json.data : []
    out.push(...data)
    const next = s(json?.last_id) ?? s(data[data.length - 1]?.id)
    if (!json?.has_more || !next || next === after || !data.length) break
    after = next
  }
  return out
}

/** Pure: an Admin API project key object -> OpenAIApiKey. */
export function parseOpenAIKey(k: any, projectId: string): OpenAIApiKey | null {
  const id = s(k?.id)
  if (!id) return null
  const o = k?.owner && typeof k.owner === "object" ? k.owner : null
  let owner: OpenAIKeyOwner | null = null
  if (o) {
    const type = s(o.type)
    const u = o.user && typeof o.user === "object" ? o.user : null
    const sa = o.service_account && typeof o.service_account === "object" ? o.service_account : null
    if (type === "service_account" || (!u && sa)) {
      owner = { type: "service_account", id: s(sa?.id), email: null, name: s(sa?.name) }
    } else if (u || type === "user") {
      owner = { type: "user", id: s(u?.id), email: normalizeEmail(u?.email), name: s(u?.name) }
    } else if (type) {
      owner = { type, id: null, email: null, name: null }
    }
  }
  const out: OpenAIApiKey = { id, name: s(k.name), project_id: projectId, owner, source: "api" }
  const createdAt = parseProviderTimestamp(k.created_at)
  if (createdAt) out.created_at = createdAt
  return out
}

/** Every project (archived included) and every project's API keys. Strict: throws OpenAIKeySyncError. */
export async function listOpenAIKeyData(adminKey: string, organizationId?: string): Promise<OpenAIKeyListing> {
  const h = headers(adminKey, organizationId)
  const rawProjects = await listAll(`${API_BASE_URL}/projects?include_archived=true`, h, "/projects")
  const projects: OpenAIProject[] = []
  for (const p of rawProjects) {
    const id = s(p?.id)
    if (id) projects.push({ id, name: s(p?.name) })
  }
  const perProject = await Promise.all(
    projects.map(async (p) => {
      const rows = await listAll(`${API_BASE_URL}/projects/${encodeURIComponent(p.id)}/api_keys`, h, "/projects/{id}/api_keys")
      return rows.map((r) => parseOpenAIKey(r, p.id)).filter((k): k is OpenAIApiKey => !!k)
    })
  )
  const seen = new Set<string>()
  const keys: OpenAIApiKey[] = []
  for (const k of perProject.flat()) {
    if (seen.has(k.id)) continue
    seen.add(k.id)
    keys.push(k)
  }
  return { keys, projects }
}

/** The fields keysFromCostRecords reads from a cost row (or a projection of one). */
export interface OpenAICostRowKeyInfo {
  metadata?: unknown
  /** Projection aliases used by the cost_records scan. */
  key_id?: unknown
  key_name?: unknown
  owner_email?: unknown
  project_id?: unknown
}

/**
 * Pure: the keys named on openai cost rows, with the creator email the
 * collector stored (metadata.api_key_owner_email), the key name and project.
 * The first non-null value per field wins.
 */
export function keysFromCostRecords(rows: OpenAICostRowKeyInfo[]): OpenAIApiKey[] {
  const out = new Map<string, OpenAIApiKey>()
  for (const r of rows) {
    const m: any = r?.metadata && typeof r.metadata === "object" ? r.metadata : {}
    const a: any = m.attribution && typeof m.attribution === "object" ? m.attribution : {}
    const id = s(r.key_id) ?? s(a.api_key_id)
    if (!id) continue
    const email = normalizeEmail(r.owner_email ?? m.api_key_owner_email)
    const name = s(r.key_name) ?? s(a.api_key_name)
    const project = s(r.project_id) ?? s(a.project_id) ?? s(m.project_id)
    const cur = out.get(id) ?? { id, name: null, project_id: null, owner: null, source: "cost_records" as const }
    cur.name ??= name
    cur.project_id ??= project
    if (email && !cur.owner) cur.owner = { type: "user", id: null, email, name: null }
    out.set(id, cur)
  }
  return [...out.values()]
}

/**
 * Keys seen on this provider's cost rows. Best-effort: returns null when the
 * scan fails. Reads only the key id, name, owner email and project (JSON
 * projections), paged and capped.
 */
export async function loadOpenAIKeysFromCostRecords(admin: SupabaseClient, providerId: string): Promise<OpenAIApiKey[] | null> {
  const rows: OpenAICostRowKeyInfo[] = []
  try {
    for (let page = 0; page < COST_ROWS_MAX_PAGES; page++) {
      const res = await admin
        .from("cost_records")
        .select(
          "id, key_id:metadata->attribution->>api_key_id, key_name:metadata->attribution->>api_key_name, owner_email:metadata->>api_key_owner_email, project_id:metadata->attribution->>project_id"
        )
        .eq("provider_id", providerId)
        .not("metadata->attribution->>api_key_id", "is", null)
        .order("id", { ascending: true })
        .range(page * COST_ROWS_PAGE, (page + 1) * COST_ROWS_PAGE - 1)
      if (res.error) throw new Error(res.error.message)
      const data = (res.data ?? []) as OpenAICostRowKeyInfo[]
      rows.push(...data)
      if (data.length < COST_ROWS_PAGE) break
    }
  } catch (e) {
    console.warn(`[openai] key sync: cost-row key scan failed, deleted keys not added: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  return keysFromCostRecords(rows)
}

/** Pure: API keys win; keys seen only on cost rows are added (deleted keys). */
export function mergeOpenAIKeys(apiKeys: OpenAIApiKey[], costRowKeys: OpenAIApiKey[]): OpenAIApiKey[] {
  const byId = new Map(apiKeys.map((k) => [k.id, k]))
  for (const k of costRowKeys) if (!byId.has(k.id)) byId.set(k.id, k)
  return [...byId.values()]
}

/**
 * Pure: who a key belongs to, before person matching. A service account has
 * no owner; a user with no email is unmatched; no owner at all is
 * no_creator. A cost-row-only key with no email is also no_creator, but
 * transient (the row didn't record the creator), so an existing email, owner
 * and reason are kept.
 */
export function resolveOpenAICreator(key: OpenAIApiKey): CreatorResolution {
  const o = key.owner
  if (!o) {
    if (key.source === "cost_records") return { createdBy: null, email: null, name: null, reason: "no_creator", transient: true }
    return { createdBy: null, email: null, name: null, reason: "no_creator", transient: false }
  }
  if (o.type === "service_account") {
    return { createdBy: o.id ? `service_account:${o.id}` : "service_account", email: null, name: o.name, reason: "service_account", transient: false }
  }
  if (o.type && o.type !== "user") {
    return { createdBy: o.id ? `${o.type}:${o.id}` : o.type, email: null, name: o.name, reason: "service_account", transient: false }
  }
  const email = normalizeEmail(o.email)
  if (!email) return { createdBy: o.id, email: null, name: o.name, reason: "unmatched_creator", transient: false }
  return { createdBy: o.id, email, name: o.name, reason: null, transient: false }
}

/**
 * person id for every email that matches a person: people.email, else an
 * openai person_identities row whose external id is the email. Never creates.
 */
export async function matchPeopleByEmail(admin: SupabaseClient, providerId: string, emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!emails.length) return out
  const people = must(await admin.from("people").select("id, email").in("email", emails), "Failed to read people") as { id: string; email: string }[]
  for (const p of people ?? []) {
    const e = normalizeEmail(p.email)
    if (e) out.set(e, p.id)
  }
  const rest = emails.filter((e) => !out.has(e))
  if (rest.length) {
    const ids = must(
      await admin.from("person_identities").select("person_id, external_id").eq("provider_id", providerId).in("external_id", rest),
      "Failed to read person_identities"
    ) as { person_id: string; external_id: string }[]
    for (const i of ids ?? []) {
      const e = normalizeEmail(i.external_id)
      if (e && !out.has(e)) out.set(e, i.person_id)
    }
  }
  return out
}

export interface OpenAISyncSummary {
  status: "success" | "error"
  created: number
  updated: number
  unchanged: number
  manual_kept: number
  keys_listed: number
  /** Keys added from cost rows only (not listed by the API, e.g. deleted). */
  keys_from_cost_records: number
  /** Always 0: the OpenAI sync only matches existing people. */
  people_created: number
  projects_created: number
  /** Non-manual keys left without an owner. */
  unresolved_creators: number
  unresolved: UnresolvedKey[]
  cost_records_unavailable?: boolean
  error?: string
}

const KEY_COLUMNS_015 =
  "id, provider_id, external_key_id, name, owner_person_id, team_id, org_project_id, external_created_by, external_created_by_email, spend_attribution, assignment_source"
const KEY_COLUMNS_017 = `${KEY_COLUMNS_015}, unresolved_reason`
const KEY_COLUMNS_018 = `${KEY_COLUMNS_017}, provider_created_at`

/** Apply the sync for an already-fetched listing. Exported for tests and the strict admin route. */
export async function applyOpenAIKeySync(admin: SupabaseClient, providerId: string, listing: OpenAIKeyListing): Promise<OpenAISyncSummary> {
  const { keys, projects } = listing
  const summary: OpenAISyncSummary = {
    status: "success",
    created: 0,
    updated: 0,
    unchanged: 0,
    manual_kept: 0,
    keys_listed: keys.length,
    keys_from_cost_records: keys.filter((k) => k.source === "cost_records").length,
    people_created: 0,
    projects_created: 0,
    unresolved_creators: 0,
    unresolved: [],
    ...(listing.cost_records_unavailable ? { cost_records_unavailable: true } : {}),
  }

  // Projects: every listed project plus every key's project.
  const projectNames = new Map<string, string | null>()
  for (const p of projects ?? []) projectNames.set(p.id, p.name)
  for (const k of keys) if (k.project_id && !projectNames.has(k.project_id)) projectNames.set(k.project_id, null)
  const ensured = await ensureProjects(admin, providerId, projectNames)
  summary.projects_created = ensured.created
  if (!keys.length) return summary

  // Existing keys (018's provider_created_at and 017's unresolved_reason when present).
  const ids = keys.map((k) => k.id)
  const { res, tier } = await selectKeyTier([KEY_COLUMNS_018, KEY_COLUMNS_017, KEY_COLUMNS_015], (columns) =>
    admin.from("org_api_keys").select(columns).eq("provider_id", providerId).in("external_key_id", ids)
  )
  const has018 = tier === 0
  const has017 = tier <= 1
  const existing = new Map(((must(res, "Failed to read org_api_keys") as unknown as AnthropicKeyRow[]) ?? []).map((r) => [r.external_key_id, r]))

  // People: match every creator email (read-only; never creates a person).
  const creators = new Map(keys.map((k) => [k.id, resolveOpenAICreator(k)]))
  const emails = new Set<string>()
  for (const c of creators.values()) if (c.email) emails.add(c.email)
  const personByEmail = await matchPeopleByEmail(admin, providerId, [...emails])

  for (const k of keys) {
    let creator = creators.get(k.id)!
    const ownerPersonId = creator.email ? (personByEmail.get(creator.email) ?? null) : null
    // An email that matches no person: no owner, reason unmatched_creator.
    if (creator.email && !ownerPersonId) creator = { ...creator, reason: "unmatched_creator" }
    const row = existing.get(k.id)
    const manual = !!row && isManual(row)
    if (manual) summary.manual_kept++
    const plan = planAnthropicKey(
      { id: k.id, name: k.name, status: null, workspace_id: null, created_by: null, principal: null, created_at: k.created_at ?? null },
      row,
      {
        creator,
        ownerPersonId,
        orgProjectId: k.project_id ? (ensured.projectByExternal.get(k.project_id) ?? null) : null,
        // OpenAI keys have no status: write unresolved_reason only, never external_status.
        has017,
        has018,
      },
      providerId
    )
    if (plan.op === "insert") delete plan.row.external_status
    if (plan.op === "update") delete plan.patch.external_status
    if (plan.op === "insert") {
      must(await admin.from("org_api_keys").insert(plan.row).select("id"), "Failed to insert org_api_keys")
      summary.created++
    } else if (plan.op === "update" && Object.keys(plan.patch).length) {
      must(await admin.from("org_api_keys").update(plan.patch).eq("id", plan.id).select("id"), "Failed to update org_api_keys")
      summary.updated++
    } else {
      summary.unchanged++
    }
    const owner =
      plan.op === "insert" ? plan.row.owner_person_id : plan.op === "update" && "owner_person_id" in plan.patch ? plan.patch.owner_person_id : row?.owner_person_id
    if (!manual && !owner && creator.reason) {
      summary.unresolved_creators++
      summary.unresolved.push({ external_key_id: k.id, name: k.name, reason: creator.reason })
    }
  }
  return summary
}

export interface OpenAISyncOptions {
  adminKey: string
  providerId: string
  organizationId?: string
  /** Pre-fetched API listing (skips the API calls). */
  listing?: OpenAIKeyListing
  /**
   * Cost rows already in hand (the collection just stored them). When given,
   * they supply the cost-row keys instead of scanning cost_records.
   */
  records?: OpenAICostRowKeyInfo[]
}

/** Add the cost-row keys (deleted keys) to an API listing. Best-effort. */
export async function withCostRecordKeys(
  admin: SupabaseClient,
  providerId: string,
  listing: OpenAIKeyListing,
  records?: OpenAICostRowKeyInfo[]
): Promise<OpenAIKeyListing> {
  const fromRows = records ? keysFromCostRecords(records) : await loadOpenAIKeysFromCostRecords(admin, providerId)
  if (!fromRows) return { ...listing, cost_records_unavailable: true }
  return { ...listing, keys: mergeOpenAIKeys(listing.keys, fromRows) }
}

/** List (strict), add cost-row keys (best-effort) and apply. Throws OpenAIKeySyncError before writing if a list fails. */
export async function syncOpenAIKeys(admin: SupabaseClient, opts: OpenAISyncOptions): Promise<OpenAISyncSummary> {
  const listing = opts.listing ?? (await listOpenAIKeyData(opts.adminKey, opts.organizationId))
  return applyOpenAIKeySync(admin, opts.providerId, await withCostRecordKeys(admin, opts.providerId, listing, opts.records))
}
