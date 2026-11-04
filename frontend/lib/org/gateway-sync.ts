/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Vercel AI Gateway key sync (issues #24, #34).
 *
 * Runs after vercel-ai-gateway collection (runner.ts) and from "Sync keys now"
 * (POST /api/admin/org/keys/sync, /keys/sync-gateway). For every gateway key
 * listed by GET api.vercel.com/v1/api-keys?purpose=ai-gateway it:
 *
 * - upserts org_api_keys (provider + key id) with the key's name, creator
 *   (createdBy, plus email from GET /v3/teams/{teamId}/members) and
 *   spendAttribution;
 * - creator is the default owner, whatever the spend attribution (user, team
 *   or unset; issue #34): createdBy -> email -> people (existing by email,
 *   else created with no team) -> owner_person_id, assignment_source 'auto'.
 *   When the members list doesn't have the creator, the creator email already
 *   stored on the key is used;
 * - no createdBy -> no owner, unresolved_reason 'no_creator'; a createdBy
 *   with no email -> no owner, 'unmatched_creator' (migration 017; both are
 *   counted in unresolved_creators);
 * - project-scoped keys: upserts org_projects (provider + projectId,
 *   best-effort name) and sets org_project_id, next to the owner.
 *
 * Manual assignments are never overwritten. org_api_keys.assignment_source
 * (migration 015) is "manual" once an admin set an owner, team or project by
 * hand (or used "Assign to creator"); the sync then only refreshes the
 * creator / spendAttribution metadata. A key with no source but an owner, team
 * or project already set counts as manual too. The sync never sets or clears
 * team_id, and never changes an org_projects team.
 *
 * Transient gaps never clear an auto assignment: if the team members list
 * couldn't be read completely, a creator that isn't in it keeps the key's
 * existing auto owner, creator email and reason.
 *
 * Migration 017 (unresolved_reason) is optional at runtime: without it the
 * reason isn't stored and everything else works.
 *
 * Migration 018 (issue #44, optional): the key's createdAt is stored in
 * provider_created_at when Vercel reports it; a key listed without one keeps
 * the stored date.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { fetchWithRetry } from "@/lib/collectors/http"
import { listGatewayKeysWithProjects, type GatewayKey } from "@/lib/collectors/vercel-ai-gateway"
import { normalizeEmail } from "./attribution"
import type { UnresolvedReason } from "./key-status"
import { ensurePeople, ensureProjects, must, providerCreatedAtChange, selectKeyTier } from "./sync-helpers"

const TEAM_MEMBERS_URL = "https://api.vercel.com/v3/teams"
const MAX_MEMBERS = 2000

export type AssignmentSource = "auto" | "manual"

/** The org_api_keys columns the sync reads. */
export interface SyncKeyRow {
  id: string
  provider_id: string
  external_key_id: string
  name: string | null
  owner_person_id: string | null
  team_id: string | null
  org_project_id: string | null
  external_created_by?: string | null
  external_created_by_email?: string | null
  spend_attribution?: string | null
  assignment_source: AssignmentSource | null
  /** Migration 017; absent when it isn't applied. */
  unresolved_reason?: string | null
  /** Migration 018; absent when it isn't applied. */
  provider_created_at?: string | null
}

export interface TeamMember {
  email: string | null
  name: string | null
}

/** True when an admin owns this key's assignment: the sync must not touch owner / team / project. */
export function isManual(row: Pick<SyncKeyRow, "assignment_source" | "owner_person_id" | "team_id" | "org_project_id">): boolean {
  if (row.assignment_source === "manual") return true
  if (row.assignment_source === "auto") return false
  return !!(row.owner_person_id || row.team_id || row.org_project_id)
}

export interface KeyPlanContext {
  /** Creator email from this run's team members (lower-cased), or null when not found. */
  creatorEmail: string | null
  /** people.id for the key's creator email (this run's, else the one stored on the key). */
  ownerPersonId: string | null
  /** org_projects.id for the key's projectId. */
  orgProjectId: string | null
  /**
   * The team members list was read completely (default true). When false, a
   * creator missing from it is a transient gap: the existing auto owner and
   * reason are kept.
   */
  membersComplete?: boolean
  /** Migration 017 (unresolved_reason) is applied (default false). */
  has017?: boolean
  /** Migration 018 (provider_created_at) is applied (default false). */
  has018?: boolean
}

export type KeyPlan =
  | { op: "insert"; row: Record<string, unknown> }
  | { op: "update"; id: string; patch: Record<string, unknown> }
  | { op: "none"; id: string }

/** Why a non-manual key ends up with no owner, or null when it has one / the gap is transient. */
function ownerlessReason(key: GatewayKey, transient: boolean, existingReason: string | null): UnresolvedReason | null {
  if (!key.createdBy) return "no_creator"
  if (transient) return (existingReason as UnresolvedReason | null) ?? null
  return "unmatched_creator"
}

/**
 * Pure: what to write for one gateway key, given the existing org_api_keys row
 * (if any) and the resolved owner / project. The owner is the creator's
 * person for every spend attribution (issue #34).
 */
export function planKey(key: GatewayKey, existing: SyncKeyRow | undefined, ctx: KeyPlanContext, providerId: string): KeyPlan {
  const membersComplete = ctx.membersComplete ?? true
  const has017 = ctx.has017 ?? false
  // A creator missing from an incomplete members list is a transient gap.
  const transient = !!key.createdBy && !ctx.creatorEmail && !membersComplete
  const meta = {
    external_created_by: key.createdBy ?? null,
    // Keep the creator email we already had if team members don't have it this time.
    external_created_by_email: ctx.creatorEmail ?? existing?.external_created_by_email ?? null,
    spend_attribution: key.spendAttribution ?? null,
  }

  if (!existing) {
    const owner = ctx.ownerPersonId
    const project = key.projectId ? ctx.orgProjectId : null
    const row: Record<string, unknown> = {
      provider_id: providerId,
      external_key_id: key.id,
      name: key.name ?? null,
      ...meta,
      owner_person_id: owner,
      team_id: null, // the sync never assigns teams
      org_project_id: project,
      assignment_source: owner || project ? "auto" : null,
    }
    if (has017) row.unresolved_reason = owner ? null : ownerlessReason(key, transient, null)
    if (ctx.has018 && key.createdAt) row.provider_created_at = key.createdAt
    return { op: "insert", row }
  }

  const patch: Record<string, unknown> = {}
  const cur = existing as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(meta)) {
    if (cur[k] !== v) patch[k] = v
  }
  if (ctx.has018) {
    const created = providerCreatedAtChange(existing.provider_created_at, key.createdAt)
    if (created) patch.provider_created_at = created
  }

  let reason: string | null
  if (!isManual(existing)) {
    if (key.name && existing.name !== key.name) patch.name = key.name
    // Owner: the creator's person; a transient gap keeps the existing auto owner.
    const owner = ctx.ownerPersonId ?? (transient ? existing.owner_person_id : null)
    // Project: scoped -> its org_projects row (kept when unresolved); unscoped -> none.
    const project = key.projectId ? (ctx.orgProjectId ?? existing.org_project_id) : null
    if (owner !== existing.owner_person_id) patch.owner_person_id = owner
    if (project !== existing.org_project_id) patch.org_project_id = project
    const source: AssignmentSource | null = owner || project ? "auto" : null
    if (source !== existing.assignment_source) patch.assignment_source = source
    reason = owner ? null : ownerlessReason(key, transient, existing.unresolved_reason ?? null)
  } else {
    if (!existing.name && key.name) patch.name = key.name
    // An admin owns this key's assignment: nothing left for the sync to explain.
    reason = null
  }
  if (has017 && (existing.unresolved_reason ?? null) !== reason) patch.unresolved_reason = reason

  return Object.keys(patch).length ? { op: "update", id: existing.id, patch } : { op: "none", id: existing.id }
}

export interface TeamMembersResult {
  members: Map<string, TeamMember>
  /** False when a page failed, the call threw or the cap was hit: a missing creator is then a transient gap. */
  complete: boolean
}

/**
 * Team members (uid -> email, name) via GET /v3/teams/{teamId}/members,
 * following pagination.next as `until`. Never throws: returns what was read
 * and whether that is the whole list.
 */
export async function listTeamMembersResult(vercelToken: string, teamId: string): Promise<TeamMembersResult> {
  const out = new Map<string, TeamMember>()
  let until: string | null = null
  let complete = false
  try {
    while (out.size < MAX_MEMBERS) {
      const params = new URLSearchParams({ limit: "100" })
      if (until) params.set("until", until)
      const res = await fetchWithRetry(`${TEAM_MEMBERS_URL}/${encodeURIComponent(teamId)}/members?${params}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${vercelToken}` },
      })
      if (!res.ok) break
      const json: any = await res.json()
      const items: any[] = json?.members ?? []
      let added = 0
      for (const m of items) {
        const uid = typeof m?.uid === "string" ? m.uid : typeof m?.id === "string" ? m.id : null
        if (!uid || out.has(uid)) continue
        out.set(uid, { email: normalizeEmail(m.email), name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : null })
        added++
      }
      const next = json?.pagination?.next
      if (next === null || next === undefined || added === 0) {
        complete = true
        break
      }
      until = String(next)
    }
  } catch {
    // keep what was read
  }
  return { members: out, complete }
}

/** listTeamMembersResult without the completeness flag. */
export async function listTeamMembers(vercelToken: string, teamId: string): Promise<Map<string, TeamMember>> {
  return (await listTeamMembersResult(vercelToken, teamId)).members
}

/** Team members are needed whenever any key has a creator (issue #34: every spend attribution). */
export function needsTeamMembers(keys: GatewayKey[]): boolean {
  return keys.some((k) => !!k.createdBy)
}

export interface UnresolvedGatewayKey {
  external_key_id: string
  name: string | null
  reason: UnresolvedReason
}

export interface GatewaySyncSummary {
  status: "success" | "error"
  /**
   * "Sync keys now" counts (issue #28). created = new org_api_keys rows (keys
   * with no spend included), updated = existing rows changed, unchanged =
   * existing rows left as they were, manual_kept = keys whose admin-set owner /
   * team / project was kept (they are also counted as updated or unchanged).
   */
  created: number
  updated: number
  unchanged: number
  manual_kept: number
  keys_listed: number
  keys_inserted: number
  keys_updated: number
  keys_unchanged: number
  /** Keys whose owner / team / project an admin set; only their metadata was refreshed. */
  keys_manual: number
  people_created: number
  projects_created: number
  /**
   * Non-manual keys left with no owner because the creator is missing
   * (no_creator) or has no email (unmatched_creator), across every spend
   * attribution (issue #34). Transient member-list gaps aren't counted.
   */
  unresolved_creators: number
  unresolved: UnresolvedGatewayKey[]
  /**
   * Issue #34: team / unset keys whose owner this run set to their creator
   * (new keys and the backfill of existing ones). They are also counted in
   * created or updated.
   */
  creator_default_assigned: number
  /** The team members list couldn't be read completely: existing auto owners were kept. */
  members_unavailable?: boolean
  error?: string
}

const KEY_COLUMNS =
  "id, provider_id, external_key_id, name, owner_person_id, team_id, org_project_id, external_created_by, external_created_by_email, spend_attribution, assignment_source"
const KEY_COLUMNS_017 = `${KEY_COLUMNS}, unresolved_reason`
const KEY_COLUMNS_018 = `${KEY_COLUMNS_017}, provider_created_at`

export interface ApplyGatewaySyncOptions {
  /** The members map is the whole team (default: true when it isn't empty). */
  membersComplete?: boolean
}

/**
 * Apply the sync for an already-listed set of keys. `members` maps Vercel uid
 * to email. Exported for tests and the strict "Sync keys now" route.
 */
export async function applyGatewayKeySync(
  admin: SupabaseClient,
  providerId: string,
  keys: GatewayKey[],
  members: Map<string, TeamMember>,
  opts: ApplyGatewaySyncOptions = {}
): Promise<GatewaySyncSummary> {
  const membersComplete = opts.membersComplete ?? members.size > 0
  const summary: GatewaySyncSummary = {
    status: "success",
    created: 0,
    updated: 0,
    unchanged: 0,
    manual_kept: 0,
    keys_listed: keys.length,
    keys_inserted: 0,
    keys_updated: 0,
    keys_unchanged: 0,
    keys_manual: 0,
    people_created: 0,
    projects_created: 0,
    unresolved_creators: 0,
    unresolved: [],
    creator_default_assigned: 0,
  }
  if (!keys.length) return summary
  if (!membersComplete && needsTeamMembers(keys)) summary.members_unavailable = true
  const finish = () => {
    summary.created = summary.keys_inserted
    summary.updated = summary.keys_updated
    summary.unchanged = summary.keys_unchanged
    summary.manual_kept = summary.keys_manual
    return summary
  }

  // Projects: one org_projects row per project-scoped key's projectId.
  const projectNames = new Map<string, string | null>()
  for (const k of keys) if (k.projectId) projectNames.set(k.projectId, k.projectName ?? projectNames.get(k.projectId) ?? null)
  const projects = await ensureProjects(admin, providerId, projectNames)
  const projectByExternal = projects.projectByExternal
  summary.projects_created += projects.created

  // Existing keys (with 018's provider_created_at and 017's unresolved_reason when applied).
  const { res, tier } = await selectKeyTier([KEY_COLUMNS_018, KEY_COLUMNS_017, KEY_COLUMNS], (columns) =>
    admin.from("org_api_keys").select(columns).eq("provider_id", providerId).in("external_key_id", keys.map((k) => k.id))
  )
  const has018 = tier === 0
  const has017 = tier <= 1
  const existingRows = must(res, "Failed to read org_api_keys") as unknown as SyncKeyRow[]
  const existing = new Map((existingRows ?? []).map((r) => [r.external_key_id, r]))

  // People: every creator with an email (this run's, else the one stored on
  // the key), for keys the sync may assign. Matched by email, else created
  // with no team. A manual key keeps its owner, so its creator isn't created.
  const memberEmail = (k: GatewayKey) => (k.createdBy ? (members.get(k.createdBy)?.email ?? null) : null)
  const ownerEmail = (k: GatewayKey) => (k.createdBy ? (memberEmail(k) ?? normalizeEmail(existing.get(k.id)?.external_created_by_email)) : null)
  const wanted = new Map<string, string | null>() // email -> display name
  for (const k of keys) {
    const row = existing.get(k.id)
    if (row && isManual(row)) continue
    const email = ownerEmail(k)
    if (email) wanted.set(email, wanted.get(email) ?? members.get(k.createdBy!)?.name ?? null)
  }
  const people = await ensurePeople(admin, wanted)
  const personByEmail = people.personByEmail
  summary.people_created += people.created

  // Keys.
  for (const k of keys) {
    const row = existing.get(k.id)
    const manual = !!row && isManual(row)
    if (manual) summary.keys_manual++
    const email = ownerEmail(k)
    const plan = planKey(
      k,
      row,
      {
        creatorEmail: memberEmail(k),
        ownerPersonId: !manual && email ? (personByEmail.get(email) ?? null) : null,
        orgProjectId: k.projectId ? (projectByExternal.get(k.projectId) ?? null) : null,
        membersComplete,
        has017,
        has018,
      },
      providerId
    )
    if (plan.op === "insert") {
      must(await admin.from("org_api_keys").insert(plan.row).select("id"), "Failed to insert org_api_keys")
      summary.keys_inserted++
    } else if (plan.op === "update") {
      must(await admin.from("org_api_keys").update(plan.patch).eq("id", plan.id).select("id"), "Failed to update org_api_keys")
      summary.keys_updated++
    } else {
      summary.keys_unchanged++
    }
    if (manual) continue
    const written = plan.op === "insert" ? plan.row : plan.op === "update" ? plan.patch : {}
    const owner = "owner_person_id" in written ? (written.owner_person_id as string | null) : (row?.owner_person_id ?? null)
    if (owner && "owner_person_id" in written && k.spendAttribution !== "user") summary.creator_default_assigned++
    if (!owner) {
      // Same reasons as planKey; a transient members gap isn't counted.
      const transient = !!k.createdBy && !memberEmail(k) && !membersComplete
      const reason: UnresolvedReason | null = !k.createdBy ? "no_creator" : transient ? null : "unmatched_creator"
      if (reason) {
        summary.unresolved_creators++
        summary.unresolved.push({ external_key_id: k.id, name: k.name ?? null, reason })
      }
    }
  }
  return finish()
}

export interface GatewaySyncOptions {
  vercelToken: string
  teamId?: string
  providerId: string
  /** Pre-listed keys (skips the key list call). */
  keys?: GatewayKey[]
}

/**
 * List gateway keys (and team members when any key has a creator), then
 * apply the sync. Every listed key is upserted, whether or not it has spend.
 *
 * The key list is strict (issue #28): if Vercel's key list fails, this throws
 * GatewayApiError before writing anything, so a Vercel outage is an error, not
 * "0 keys synced". Team-member and project-name lookups stay best-effort: a
 * failure there leaves creators unresolved (existing auto owners are kept) or
 * project names null (existing names are kept). Database errors throw too.
 */
export async function syncGatewayKeys(admin: SupabaseClient, opts: GatewaySyncOptions): Promise<GatewaySyncSummary> {
  const keys = opts.keys ?? (await listGatewayKeysWithProjects(opts.vercelToken, opts.teamId, { strict: true }))
  const { members, complete } = await loadTeamMembers(opts.vercelToken, opts.teamId, keys)
  return applyGatewayKeySync(admin, opts.providerId, keys, members, { membersComplete: complete })
}

/**
 * Team members for a key listing: fetched whenever any key has a creator.
 * No team id means the members can't be read (complete = false, so existing
 * auto owners are kept).
 */
export async function loadTeamMembers(vercelToken: string, teamId: string | undefined, keys: GatewayKey[]): Promise<TeamMembersResult> {
  if (!needsTeamMembers(keys)) return { members: new Map(), complete: true }
  if (!teamId) return { members: new Map(), complete: false }
  return listTeamMembersResult(vercelToken, teamId)
}
