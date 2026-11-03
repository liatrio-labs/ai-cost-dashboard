/* eslint-disable @typescript-eslint/no-explicit-any -- untyped provider JSON is parsed defensively */
/**
 * Vercel AI Gateway key sync (issue #24).
 *
 * Runs after vercel-ai-gateway collection (runner.ts) and as an admin action
 * (POST /api/admin/org/keys/sync-gateway). For every gateway key listed by
 * GET api.vercel.com/v1/api-keys?purpose=ai-gateway it:
 *
 * - upserts org_api_keys (provider + key id) with the key's name, creator
 *   (createdBy, plus email from team members) and spendAttribution;
 * - spendAttribution = "user": maps createdBy -> email via
 *   GET /v3/teams/{teamId}/members -> people (existing by email, else created
 *   with no team) and sets owner_person_id;
 * - spendAttribution = "team" or unset: no owner (the key stays unassigned
 *   until an admin assigns it);
 * - project-scoped keys: upserts org_projects (provider + projectId, best-effort
 *   name) and sets org_project_id.
 *
 * Manual assignments are never overwritten. org_api_keys.assignment_source
 * (migration 015) is "manual" once an admin set an owner, team or project by
 * hand; the sync then only refreshes the creator / spendAttribution metadata.
 * A key with no source but an owner, team or project already set counts as
 * manual too. The sync never sets or clears team_id, and never changes an
 * org_projects team.
 *
 * Transient gaps never clear an auto assignment: if the creator's email can't
 * be resolved (members call failed) the existing auto owner is kept.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { fetchWithRetry } from "@/lib/collectors/http"
import { listGatewayKeysWithProjects, type GatewayKey } from "@/lib/collectors/vercel-ai-gateway"
import { normalizeEmail } from "./attribution"
import { ensurePeople, ensureProjects, must } from "./sync-helpers"

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
  /** Creator email for this key (lower-cased), or null when unknown. */
  creatorEmail: string | null
  /** people.id for creatorEmail, when the key is user-attributed. */
  ownerPersonId: string | null
  /** org_projects.id for the key's projectId. */
  orgProjectId: string | null
}

export type KeyPlan =
  | { op: "insert"; row: Record<string, unknown> }
  | { op: "update"; id: string; patch: Record<string, unknown> }
  | { op: "none"; id: string }

/**
 * Pure: what to write for one gateway key, given the existing org_api_keys row
 * (if any) and the resolved owner / project.
 */
export function planKey(key: GatewayKey, existing: SyncKeyRow | undefined, ctx: KeyPlanContext, providerId: string): KeyPlan {
  const meta = {
    external_created_by: key.createdBy ?? null,
    external_created_by_email: ctx.creatorEmail,
    spend_attribution: key.spendAttribution ?? null,
  }
  const userAttributed = key.spendAttribution === "user"

  if (!existing) {
    const owner = userAttributed ? ctx.ownerPersonId : null
    const project = key.projectId ? ctx.orgProjectId : null
    return {
      op: "insert",
      row: {
        provider_id: providerId,
        external_key_id: key.id,
        name: key.name ?? null,
        ...meta,
        owner_person_id: owner,
        team_id: null, // the sync never assigns teams
        org_project_id: project,
        assignment_source: owner || project ? "auto" : null,
      },
    }
  }

  const patch: Record<string, unknown> = {}
  // Keep the creator email we already had if team members couldn't be read this time.
  const next = { ...meta, external_created_by_email: meta.external_created_by_email ?? existing.external_created_by_email ?? null }
  for (const [k, v] of Object.entries(next)) {
    if ((existing as unknown as Record<string, unknown>)[k] !== v) patch[k] = v
  }

  if (!isManual(existing)) {
    if (key.name && existing.name !== key.name) patch.name = key.name
    // Owner: user-attributed -> creator's person (kept when unresolved this run);
    // team / unset -> none.
    const owner = userAttributed ? (ctx.ownerPersonId ?? existing.owner_person_id) : null
    // Project: scoped -> its org_projects row (kept when unresolved); unscoped -> none.
    const project = key.projectId ? (ctx.orgProjectId ?? existing.org_project_id) : null
    if (owner !== existing.owner_person_id) patch.owner_person_id = owner
    if (project !== existing.org_project_id) patch.org_project_id = project
    const source: AssignmentSource | null = owner || project ? "auto" : null
    if (source !== existing.assignment_source) patch.assignment_source = source
  } else if (!existing.name && key.name) {
    patch.name = key.name
  }

  return Object.keys(patch).length ? { op: "update", id: existing.id, patch } : { op: "none", id: existing.id }
}

/**
 * Team members (uid -> email, name) via GET /v3/teams/{teamId}/members,
 * following pagination.next as `until`. Never throws: returns what was read.
 */
export async function listTeamMembers(vercelToken: string, teamId: string): Promise<Map<string, TeamMember>> {
  const out = new Map<string, TeamMember>()
  let until: string | null = null
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
      if (next === null || next === undefined || added === 0) break
      until = String(next)
    }
  } catch {
    // keep what was read
  }
  return out
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
  /** user-attributed keys whose creator couldn't be mapped to an email. */
  unresolved_creators: number
  error?: string
}


const KEY_COLUMNS =
  "id, provider_id, external_key_id, name, owner_person_id, team_id, org_project_id, external_created_by, external_created_by_email, spend_attribution, assignment_source"

/**
 * Apply the sync for an already-listed set of keys. `members` maps Vercel uid
 * to email. Exported for tests; production calls syncGatewayKeys.
 */
export async function applyGatewayKeySync(
  admin: SupabaseClient,
  providerId: string,
  keys: GatewayKey[],
  members: Map<string, TeamMember>
): Promise<GatewaySyncSummary> {
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
  }
  if (!keys.length) return summary
  const finish = () => {
    summary.created = summary.keys_inserted
    summary.updated = summary.keys_updated
    summary.unchanged = summary.keys_unchanged
    summary.manual_kept = summary.keys_manual
    return summary
  }

  // People: creators of user-attributed keys, matched by email, else created (no team).
  const creatorEmail = (k: GatewayKey) => (k.createdBy ? (members.get(k.createdBy)?.email ?? null) : null)
  const wanted = new Map<string, string | null>() // email -> display name
  for (const k of keys) {
    if (k.spendAttribution !== "user") continue
    const email = creatorEmail(k)
    if (!email) {
      summary.unresolved_creators++
      continue
    }
    wanted.set(email, members.get(k.createdBy!)?.name ?? null)
  }
  const people = await ensurePeople(admin, wanted)
  const personByEmail = people.personByEmail
  summary.people_created += people.created

  // Projects: one org_projects row per project-scoped key's projectId.
  const projectNames = new Map<string, string | null>()
  for (const k of keys) if (k.projectId) projectNames.set(k.projectId, k.projectName ?? projectNames.get(k.projectId) ?? null)
  const projects = await ensureProjects(admin, providerId, projectNames)
  const projectByExternal = projects.projectByExternal
  summary.projects_created += projects.created

  // Keys.
  const existingRows = must(
    await admin.from("org_api_keys").select(KEY_COLUMNS).eq("provider_id", providerId).in("external_key_id", keys.map((k) => k.id)),
    "Failed to read org_api_keys"
  ) as SyncKeyRow[]
  const existing = new Map((existingRows ?? []).map((r) => [r.external_key_id, r]))

  for (const k of keys) {
    const email = creatorEmail(k)
    const row = existing.get(k.id)
    if (row && isManual(row)) summary.keys_manual++
    const plan = planKey(
      k,
      row,
      {
        creatorEmail: email,
        ownerPersonId: k.spendAttribution === "user" && email ? (personByEmail.get(email) ?? null) : null,
        orgProjectId: k.projectId ? (projectByExternal.get(k.projectId) ?? null) : null,
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
 * List gateway keys (and team members when any key is user-attributed), then
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
  const needMembers = keys.some((k) => k.spendAttribution === "user" && k.createdBy)
  const members = needMembers && opts.teamId ? await listTeamMembers(opts.vercelToken, opts.teamId) : new Map<string, TeamMember>()
  return applyGatewayKeySync(admin, opts.providerId, keys, members)
}
