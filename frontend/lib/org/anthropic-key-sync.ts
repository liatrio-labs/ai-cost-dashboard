/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Anthropic key sync (issue #32), modeled on gateway-sync.ts.
 *
 * Runs best-effort after every anthropic collection (runner.ts, reported as
 * `key_sync`) and strictly from "Sync keys now"
 * (POST /api/admin/org/keys/sync). With the anthropic provider's Admin key it
 * lists:
 *
 *   GET /v1/organizations/api_keys    every status, limit 1000, after_id paging
 *   GET /v1/organizations/users       creator id -> email / name
 *   GET /v1/organizations/workspaces  include_default=true, include_archived=true
 *
 * and then:
 *
 * - Workspaces become org_projects (provider anthropic, external id =
 *   workspace id). The default workspace (keys with workspace_id null) is the
 *   project "default" named "Default". Existing projects only get a missing
 *   name filled in; a project's name or team set by hand is never changed.
 * - Every key is upserted into org_api_keys: name, status (017), creator id
 *   and email, org_project_id = its workspace project, spend_attribution NULL.
 * - Auto owner: principal.user_id, else created_by.id when it is a user ->
 *   email (users list) -> people (matched by email, else created with no
 *   team) -> owner_person_id, assignment_source 'auto'. Service accounts,
 *   deleted users, creators with no email and null creators get no owner;
 *   the reason is stored in unresolved_reason (017) and counted in
 *   unresolved_creators.
 * - Manual keys (assignment_source 'manual', or an owner / team / project set
 *   before 015) keep their owner, team and project; only metadata refreshes.
 * - If the users list fails, the lookup is transient: the existing owner,
 *   email and reason are kept.
 *
 * The key list is strict: a failure throws AnthropicKeySyncError before
 * anything is written. Users and workspaces are best-effort.
 *
 * Migration 017 (external_status, unresolved_reason) is optional at runtime:
 * when it isn't applied the sync reads and writes the 015 columns only.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { fetchWithRetry } from "@/lib/collectors/http"
import { normalizeEmail } from "./attribution"
import { isManual, type AssignmentSource, type SyncKeyRow } from "./gateway-sync"
import type { UnresolvedReason } from "./key-status"
import { ensurePeople, ensureProjects, must } from "./sync-helpers"

const ADMIN_API_BASE_URL = "https://api.anthropic.com/v1/organizations"
const ANTHROPIC_VERSION = "2023-06-01"
const PAGE_LIMIT = 1000
const MAX_PAGES = 200

/** External id of the default workspace's project (its keys have workspace_id null). */
export const DEFAULT_WORKSPACE_PROJECT_ID = "default"
export const DEFAULT_WORKSPACE_PROJECT_NAME = "Default"

export { UNRESOLVED_REASONS, UNRESOLVED_REASON_TEXT, type UnresolvedReason } from "./key-status"

export class AnthropicKeySyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AnthropicKeySyncError"
  }
}

export interface AnthropicApiKey {
  id: string
  name: string | null
  /** active | inactive | archived */
  status: string | null
  /** null = default workspace */
  workspace_id: string | null
  created_by: { id: string | null; type: string | null } | null
  /** Who the key acts for, when the API reports it (wins over created_by). */
  principal: { user_id: string | null; id: string | null; type: string | null } | null
}

export interface AnthropicUser {
  email: string | null
  name: string | null
}

export interface AnthropicWorkspace {
  id: string | null
  name: string | null
  is_default: boolean
}

export interface AnthropicKeyListing {
  keys: AnthropicApiKey[]
  /** user id -> user; null when the users list failed (transient). */
  users: Map<string, AnthropicUser> | null
  /** null when the workspaces list failed (names unknown). */
  workspaces: AnthropicWorkspace[] | null
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

/** A principal / creator type that denotes a person: "user", "user_actor" (the analytics API's name) or unset. */
function isUserType(type: string | null | undefined): boolean {
  if (!type) return true
  const t = type.toLowerCase()
  return t === "user" || t === "user_actor"
}

function parseKey(k: any): AnthropicApiKey | null {
  const id = s(k?.id)
  if (!id) return null
  const cb = k?.created_by && typeof k.created_by === "object" ? k.created_by : null
  const pr = k?.principal && typeof k.principal === "object" ? k.principal : null
  return {
    id,
    name: s(k.name),
    status: s(k.status),
    workspace_id: s(k.workspace_id),
    created_by: cb ? { id: s(cb.id), type: s(cb.type) } : null,
    principal: pr ? { user_id: s(pr.user_id) ?? (isUserType(s(pr.type)) ? s(pr.id) : null), id: s(pr.id), type: s(pr.type) } : null,
  }
}

/** GET a paginated Admin API list (after_id / has_more / last_id). Throws on any non-2xx page. */
async function listAll(adminKey: string, path: string, extra: Record<string, string> = {}): Promise<any[]> {
  const out: any[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), ...extra })
    if (after) params.set("after_id", after)
    const res = await fetchWithRetry(`${ADMIN_API_BASE_URL}${path}?${params}`, {
      method: "GET",
      headers: { "anthropic-version": ANTHROPIC_VERSION, "x-api-key": adminKey },
    })
    if (!res.ok) throw new AnthropicKeySyncError(`Anthropic Admin API ${path} failed: HTTP ${res.status}`)
    const json: any = await res.json()
    const data: any[] = Array.isArray(json?.data) ? json.data : []
    out.push(...data)
    const next = s(json?.last_id) ?? s(data[data.length - 1]?.id)
    if (!json?.has_more || !next || next === after || !data.length) break
    after = next
  }
  return out
}

/** Every API key, all statuses. Strict: throws AnthropicKeySyncError on failure. */
export async function listAnthropicApiKeys(adminKey: string): Promise<AnthropicApiKey[]> {
  const rows = await listAll(adminKey, "/api_keys")
  const seen = new Set<string>()
  const out: AnthropicApiKey[] = []
  for (const r of rows) {
    const k = parseKey(r)
    if (!k || seen.has(k.id)) continue
    seen.add(k.id)
    out.push(k)
  }
  return out
}

/** Organization users (id -> email / name). Best-effort: null on failure. */
export async function listAnthropicUsers(adminKey: string): Promise<Map<string, AnthropicUser> | null> {
  try {
    const rows = await listAll(adminKey, "/users")
    const out = new Map<string, AnthropicUser>()
    for (const u of rows) {
      const id = s(u?.id)
      if (id) out.set(id, { email: normalizeEmail(u.email), name: s(u.name) })
    }
    return out
  } catch {
    return null
  }
}

/** Workspaces, default and archived included. Best-effort: null on failure. */
export async function listAnthropicWorkspaces(adminKey: string): Promise<AnthropicWorkspace[] | null> {
  try {
    const rows = await listAll(adminKey, "/workspaces", { include_default: "true", include_archived: "true" })
    return rows.map((w) => {
      const id = s(w?.id)
      return {
        id,
        name: s(w?.name) ?? s(w?.display_name),
        is_default: w?.is_default === true || w?.type === "default_workspace" || !id || id === DEFAULT_WORKSPACE_PROJECT_ID,
      }
    })
  } catch {
    return null
  }
}

/** Keys (strict) plus users and workspaces (best-effort). Throws AnthropicKeySyncError if the key list fails. */
export async function listAnthropicKeyData(adminKey: string): Promise<AnthropicKeyListing> {
  const keys = await listAnthropicApiKeys(adminKey)
  const [users, workspaces] = await Promise.all([listAnthropicUsers(adminKey), listAnthropicWorkspaces(adminKey)])
  return { keys, users, workspaces }
}

export interface CreatorResolution {
  /** Stored in external_created_by: the user id, or "type:id" for non-user creators. */
  createdBy: string | null
  email: string | null
  name: string | null
  /** Why there is no owner; null when the creator resolved to an email. */
  reason: UnresolvedReason | null
  /** The users list failed, so the creator couldn't be looked up this run. */
  transient: boolean
}

/**
 * Pure: who a key belongs to. principal (a user) wins over created_by; a
 * non-user creator is a service account; a user missing from a successful
 * users list is deleted; a listed user with no email is unmatched.
 */
export function resolveCreator(key: AnthropicApiKey, users: Map<string, AnthropicUser> | null): CreatorResolution {
  // A principal naming a user (type "user", "user_actor" or absent) wins; one
  // with a non-user type and no user id is a service account.
  const principalUser = key.principal?.user_id && isUserType(key.principal.type) ? key.principal.user_id : null
  const principalOther = !principalUser && key.principal?.type && !isUserType(key.principal.type) ? key.principal : null
  const cb = key.created_by
  let userId: string | null = principalUser
  if (!userId && !principalOther && cb?.id) {
    const type = (cb.type ?? "user").toLowerCase()
    if (type === "user") userId = cb.id
    else if (type.includes("deleted")) return { createdBy: `${type}:${cb.id}`, email: null, name: null, reason: "deleted_user", transient: false }
    else return { createdBy: `${type}:${cb.id}`, email: null, name: null, reason: "service_account", transient: false }
  }
  if (principalOther) {
    const id = principalOther.id ?? principalOther.user_id ?? cb?.id ?? null
    return { createdBy: id ? `${principalOther.type}:${id}` : null, email: null, name: null, reason: "service_account", transient: false }
  }
  if (!userId) return { createdBy: null, email: null, name: null, reason: "no_creator", transient: false }
  if (!users) return { createdBy: userId, email: null, name: null, reason: null, transient: true }
  const u = users.get(userId)
  if (!u) return { createdBy: userId, email: null, name: null, reason: "deleted_user", transient: false }
  if (!u.email) return { createdBy: userId, email: null, name: u.name, reason: "unmatched_creator", transient: false }
  return { createdBy: userId, email: u.email, name: u.name, reason: null, transient: false }
}

/** The external project id for a key's workspace. */
export function workspaceProjectId(workspaceId: string | null, defaultIds: Set<string> = new Set()): string {
  return workspaceId && !defaultIds.has(workspaceId) ? workspaceId : DEFAULT_WORKSPACE_PROJECT_ID
}

export interface AnthropicKeyRow extends SyncKeyRow {
  external_status?: string | null
  unresolved_reason?: string | null
}

export interface AnthropicPlanContext {
  creator: CreatorResolution
  ownerPersonId: string | null
  orgProjectId: string | null
  /** Migration 017 columns are present. */
  has017: boolean
}

export type AnthropicKeyPlan =
  | { op: "insert"; row: Record<string, unknown> }
  | { op: "update"; id: string; patch: Record<string, unknown> }
  | { op: "none"; id: string }

/** Pure: what to write for one key, given its existing org_api_keys row (if any). */
export function planAnthropicKey(
  key: AnthropicApiKey,
  existing: AnthropicKeyRow | undefined,
  ctx: AnthropicPlanContext,
  providerId: string
): AnthropicKeyPlan {
  const { creator } = ctx
  const meta: Record<string, unknown> = {
    external_created_by: creator.createdBy,
    // A transient lookup keeps the email we already had.
    external_created_by_email: creator.transient ? (existing?.external_created_by_email ?? null) : creator.email,
    spend_attribution: null,
  }
  if (ctx.has017) meta.external_status = key.status

  if (!existing) {
    const owner = ctx.ownerPersonId
    const project = ctx.orgProjectId
    const row: Record<string, unknown> = {
      provider_id: providerId,
      external_key_id: key.id,
      name: key.name,
      ...meta,
      owner_person_id: owner,
      team_id: null, // the sync never assigns teams
      org_project_id: project,
      assignment_source: owner || project ? "auto" : null,
    }
    if (ctx.has017) row.unresolved_reason = owner ? null : creator.reason
    return { op: "insert", row }
  }

  const patch: Record<string, unknown> = {}
  const cur = existing as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(meta)) if ((cur[k] ?? null) !== v) patch[k] = v

  let finalOwner: string | null
  if (!isManual(existing)) {
    if (key.name && existing.name !== key.name) patch.name = key.name
    const owner = ctx.ownerPersonId ?? (creator.transient ? existing.owner_person_id : null)
    const project = ctx.orgProjectId ?? existing.org_project_id
    if (owner !== existing.owner_person_id) patch.owner_person_id = owner
    if (project !== existing.org_project_id) patch.org_project_id = project
    const source: AssignmentSource | null = owner || project ? "auto" : null
    if (source !== existing.assignment_source) patch.assignment_source = source
    finalOwner = owner
  } else {
    if (!existing.name && key.name) patch.name = key.name
    finalOwner = existing.owner_person_id
  }
  if (ctx.has017) {
    const reason = finalOwner ? null : creator.transient ? (existing.unresolved_reason ?? null) : creator.reason
    if ((existing.unresolved_reason ?? null) !== reason) patch.unresolved_reason = reason
  }
  return Object.keys(patch).length ? { op: "update", id: existing.id, patch } : { op: "none", id: existing.id }
}

export interface UnresolvedKey {
  external_key_id: string
  name: string | null
  reason: UnresolvedReason
}

export interface AnthropicSyncSummary {
  status: "success" | "error"
  created: number
  updated: number
  unchanged: number
  manual_kept: number
  keys_listed: number
  people_created: number
  projects_created: number
  /** Non-manual keys left without an owner (service account, deleted, unmatched or no creator). */
  unresolved_creators: number
  unresolved: UnresolvedKey[]
  /** Users list failed: existing auto owners were kept. */
  users_unavailable?: boolean
  /** Workspaces list failed: project names were not filled. */
  workspaces_unavailable?: boolean
  error?: string
}

const KEY_COLUMNS_015 =
  "id, provider_id, external_key_id, name, owner_person_id, team_id, org_project_id, external_created_by, external_created_by_email, spend_attribution, assignment_source"
const KEY_COLUMNS_017 = `${KEY_COLUMNS_015}, external_status, unresolved_reason`

function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204" || /column .* does not exist/i.test(error.message ?? ""))
}

/** Apply the sync for an already-fetched listing. Exported for tests and the strict admin route. */
export async function applyAnthropicKeySync(
  admin: SupabaseClient,
  providerId: string,
  listing: AnthropicKeyListing
): Promise<AnthropicSyncSummary> {
  const { keys, users, workspaces } = listing
  const summary: AnthropicSyncSummary = {
    status: "success",
    created: 0,
    updated: 0,
    unchanged: 0,
    manual_kept: 0,
    keys_listed: keys.length,
    people_created: 0,
    projects_created: 0,
    unresolved_creators: 0,
    unresolved: [],
    ...(users ? {} : { users_unavailable: true }),
    ...(workspaces ? {} : { workspaces_unavailable: true }),
  }

  // Projects: every listed workspace (archived and default included) plus every key's workspace.
  const defaultIds = new Set<string>()
  const projectNames = new Map<string, string | null>()
  let hasDefault = false
  for (const w of workspaces ?? []) {
    if (w.is_default) {
      hasDefault = true
      if (w.id) defaultIds.add(w.id)
    } else if (w.id) projectNames.set(w.id, w.name)
  }
  for (const k of keys) {
    const ext = workspaceProjectId(k.workspace_id, defaultIds)
    if (ext === DEFAULT_WORKSPACE_PROJECT_ID) hasDefault = true
    else if (!projectNames.has(ext)) projectNames.set(ext, null)
  }
  if (hasDefault) projectNames.set(DEFAULT_WORKSPACE_PROJECT_ID, DEFAULT_WORKSPACE_PROJECT_NAME)
  const projects = await ensureProjects(admin, providerId, projectNames)
  summary.projects_created = projects.created
  if (!keys.length) return summary

  const creators = new Map(keys.map((k) => [k.id, resolveCreator(k, users)]))

  // Existing keys (017 columns when present).
  let has017 = true
  const ids = keys.map((k) => k.id)
  const readKeys = (columns: string) =>
    admin.from("org_api_keys").select(columns).eq("provider_id", providerId).in("external_key_id", ids)
  let res = await readKeys(KEY_COLUMNS_017)
  if (isMissingColumn(res.error)) {
    has017 = false
    res = await readKeys(KEY_COLUMNS_015)
  }
  const existing = new Map(((must(res, "Failed to read org_api_keys") as unknown as AnthropicKeyRow[]) ?? []).map((r) => [r.external_key_id, r]))

  // People: creators that resolved to an email, only for keys the sync may
  // assign (a manual key keeps its owner, so its creator isn't created).
  const wanted = new Map<string, string | null>()
  for (const k of keys) {
    const row = existing.get(k.id)
    const c = creators.get(k.id)!
    if (c.email && !(row && isManual(row))) wanted.set(c.email, wanted.get(c.email) ?? c.name)
  }
  const people = await ensurePeople(admin, wanted)
  summary.people_created = people.created

  for (const k of keys) {
    const creator = creators.get(k.id)!
    const row = existing.get(k.id)
    const manual = !!row && isManual(row)
    if (manual) summary.manual_kept++
    const plan = planAnthropicKey(
      k,
      row,
      {
        creator,
        ownerPersonId: creator.email ? (people.personByEmail.get(creator.email) ?? null) : null,
        orgProjectId: projects.projectByExternal.get(workspaceProjectId(k.workspace_id, defaultIds)) ?? null,
        has017,
      },
      providerId
    )
    if (plan.op === "insert") {
      must(await admin.from("org_api_keys").insert(plan.row).select("id"), "Failed to insert org_api_keys")
      summary.created++
    } else if (plan.op === "update") {
      must(await admin.from("org_api_keys").update(plan.patch).eq("id", plan.id).select("id"), "Failed to update org_api_keys")
      summary.updated++
    } else {
      summary.unchanged++
    }
    const owner = plan.op === "insert" ? plan.row.owner_person_id : plan.op === "update" && "owner_person_id" in plan.patch ? plan.patch.owner_person_id : row?.owner_person_id
    if (!manual && !owner && creator.reason) {
      summary.unresolved_creators++
      summary.unresolved.push({ external_key_id: k.id, name: k.name, reason: creator.reason })
    }
  }
  return summary
}

export interface AnthropicSyncOptions {
  adminKey: string
  providerId: string
  /** Pre-fetched listing (skips the API calls). */
  listing?: AnthropicKeyListing
}

/** List (strict key list) and apply. Throws AnthropicKeySyncError before writing if the key list fails. */
export async function syncAnthropicKeys(admin: SupabaseClient, opts: AnthropicSyncOptions): Promise<AnthropicSyncSummary> {
  const listing = opts.listing ?? (await listAnthropicKeyData(opts.adminKey))
  return applyAnthropicKeySync(admin, opts.providerId, listing)
}
