/**
 * Pure summaries of observed cost_records attribution for the admin screens:
 * people to import, keys and projects seen in the data, and the Unassigned
 * queue. Resolution goes through resolveAttribution, which mirrors the
 * cost_records_daily_attributed view, so "unassigned" here means exactly what
 * the dashboard shows as Unassigned.
 */

import { buildOrgIndex, getAttribution, normalizeEmail, resolveAttribution } from "../attribution"
import type { OrgApiKey, OrgData, OrgProject } from "../types"
import type { OrgSnapshot } from "./schemas"

/** The slice of a cost_records row these summaries need. */
export interface ObservedRecord {
  /** cost_records.id, when selected (used to de-duplicate overlapping scans). */
  id?: string
  provider_id: string
  timestamp?: string
  cost_usd: number | string
  /** metadata.attribution (selected as `attribution:metadata->attribution`). */
  attribution?: unknown
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6
const SEP = "\u0000"
const pkey = (providerId: string, id: string) => `${providerId}${SEP}${id}`

function num(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function orgDataOf(org: OrgSnapshot): OrgData {
  return {
    departments: org.departments,
    teams: org.teams,
    people: org.people,
    identities: org.identities,
    apiKeys: org.apiKeys,
    projects: org.projects,
  }
}

const attributionOf = (r: ObservedRecord) => getAttribution({ attribution: r.attribution })

// ---------------------------------------------------------------------------
// People import
// ---------------------------------------------------------------------------

export interface ImportCandidate {
  email: string
  display_name: string | null
  provider_ids: string[]
  total_cost_usd: number
  record_count: number
}

export interface ImportConflict {
  email: string
  /** People the email's identity-matched records already resolve to. */
  person_ids: string[]
  /** Spend on records that resolve to nobody yet. */
  unmatched_cost_usd: number
}

export interface ImportPreview {
  /** Distinct observed emails none of whose records resolve to anyone yet. */
  candidates: ImportCandidate[]
  /** Distinct observed emails whose every record already resolves to a person. */
  already_known: string[]
  /**
   * Emails that resolve through a person identity on some records and to
   * nobody on others. Importing one would create a people row whose exact
   * email match beats the identity, moving spend that already belongs to
   * someone, so they are never imported. Fix them by adding an identity for
   * the unmatched provider to the existing person instead.
   */
  conflicts: ImportConflict[]
}

/**
 * Distinct attribution.person_email values, split into candidates (no record
 * resolves to anyone), already known (every record resolves through
 * people.email or an identity) and conflicts (some records resolve through an
 * identity, others to nobody).
 */
export function previewPeopleImport(records: ObservedRecord[], org: OrgSnapshot): ImportPreview {
  const peopleEmails = new Set(org.people.map((p) => normalizeEmail(p.email)).filter(Boolean))
  const identities = new Map(org.identities.map((i) => [pkey(i.provider_id, i.external_id), i.person_id]))
  const seen = new Map<
    string,
    ImportCandidate & { providers: Set<string>; identityPeople: Set<string>; unmatched: number; unmatchedCost: number }
  >()

  for (const r of records) {
    const a = attributionOf(r)
    const email = a?.person_email
    if (!email) continue
    let c = seen.get(email)
    if (!c) {
      c = {
        email,
        display_name: null,
        provider_ids: [],
        providers: new Set(),
        total_cost_usd: 0,
        record_count: 0,
        identityPeople: new Set(),
        unmatched: 0,
        unmatchedCost: 0,
      }
      seen.set(email, c)
    }
    c.display_name ??= a?.person_name ?? null
    c.providers.add(r.provider_id)
    c.total_cost_usd += num(r.cost_usd)
    c.record_count += 1
    if (peopleEmails.has(email)) continue
    // Same identity paths as resolveAttribution: external id first, then email.
    const viaIdentity =
      (a?.person_external_id ? identities.get(pkey(r.provider_id, a.person_external_id)) : undefined) ??
      identities.get(pkey(r.provider_id, email))
    if (viaIdentity) {
      c.identityPeople.add(viaIdentity)
    } else {
      c.unmatched += 1
      c.unmatchedCost += num(r.cost_usd)
    }
  }

  const candidates: ImportCandidate[] = []
  const already_known: string[] = []
  const conflicts: ImportConflict[] = []
  for (const c of seen.values()) {
    if (!c.unmatched) {
      already_known.push(c.email)
    } else if (c.identityPeople.size) {
      conflicts.push({
        email: c.email,
        person_ids: [...c.identityPeople].sort(),
        unmatched_cost_usd: round6(c.unmatchedCost),
      })
    } else {
      candidates.push({
        email: c.email,
        display_name: c.display_name,
        provider_ids: [...c.providers].sort(),
        total_cost_usd: round6(c.total_cost_usd),
        record_count: c.record_count,
      })
    }
  }
  candidates.sort((a, b) => b.total_cost_usd - a.total_cost_usd || a.email.localeCompare(b.email))
  conflicts.sort((a, b) => a.email.localeCompare(b.email))
  return { candidates, already_known: already_known.sort(), conflicts }
}

// ---------------------------------------------------------------------------
// Keys and projects: observed in data plus registered rows
// ---------------------------------------------------------------------------

export interface KeyRow {
  provider_id: string
  external_key_id: string
  name: string | null
  /** org_api_keys.id when registered, else null (observed only). */
  id: string | null
  owner_person_id: string | null
  team_id: string | null
  /** Migration 015 (AI Gateway keys): project, creator, spendAttribution and assignment source. */
  org_project_id: string | null
  /** The key's project from collected rows (attribution.project_id), when scoped. */
  observed_project_id: string | null
  /** The key's Anthropic workspace from collected rows (attribution.workspace_id), issue #28. */
  observed_workspace_id: string | null
  external_created_by: string | null
  external_created_by_email: string | null
  spend_attribution: string | null
  assignment_source: "auto" | "manual" | null
  /** Provider key status (Anthropic, migration 017). */
  external_status: string | null
  /** Why the key sync left the key without an owner (migration 017, issue #32). */
  unresolved_reason: string | null
  observed: boolean
  total_cost_usd: number
  record_count: number
  last_seen: string | null
}

export interface ProjectRow {
  provider_id: string
  external_project_id: string
  /** "workspace" for Anthropic workspaces (attribution.workspace_id, issue #28), else "project". */
  kind: "project" | "workspace"
  name: string | null
  id: string | null
  team_id: string | null
  observed: boolean
  total_cost_usd: number
  record_count: number
  last_seen: string | null
}

interface Seen {
  name: string | null
  total: number
  count: number
  last: string | null
}

function bump(map: Map<string, Seen>, key: string, r: ObservedRecord, name: string | null | undefined) {
  const s = map.get(key) ?? { name: null, total: 0, count: 0, last: null }
  if (name && (!s.name || (r.timestamp && (!s.last || r.timestamp >= s.last)))) s.name = name
  s.total += num(r.cost_usd)
  s.count += 1
  if (r.timestamp && (!s.last || r.timestamp > s.last)) s.last = r.timestamp
  map.set(key, s)
}

const bySpend = <T extends { total_cost_usd: number; provider_id: string }>(a: T, b: T) =>
  b.total_cost_usd - a.total_cost_usd || a.provider_id.localeCompare(b.provider_id)

/** Every key seen in attribution.api_key_id, merged with registered org_api_keys. */
export function listKeys(records: ObservedRecord[], registered: OrgApiKey[]): KeyRow[] {
  const seen = new Map<string, Seen>()
  const keyProject = new Map<string, string>()
  const keyWorkspace = new Map<string, string>()
  for (const r of records) {
    const a = attributionOf(r)
    if (!a?.api_key_id) continue
    bump(seen, pkey(r.provider_id, a.api_key_id), r, a.api_key_name)
    if (a.project_id) keyProject.set(pkey(r.provider_id, a.api_key_id), a.project_id)
    if (a.workspace_id) keyWorkspace.set(pkey(r.provider_id, a.api_key_id), a.workspace_id)
  }
  const rows = new Map<string, KeyRow>()
  for (const k of registered) {
    const s = seen.get(pkey(k.provider_id, k.external_key_id))
    rows.set(pkey(k.provider_id, k.external_key_id), {
      provider_id: k.provider_id,
      external_key_id: k.external_key_id,
      name: k.name ?? s?.name ?? null,
      id: k.id,
      owner_person_id: k.owner_person_id,
      team_id: k.team_id,
      org_project_id: k.org_project_id ?? null,
      observed_project_id: keyProject.get(pkey(k.provider_id, k.external_key_id)) ?? null,
      observed_workspace_id: keyWorkspace.get(pkey(k.provider_id, k.external_key_id)) ?? null,
      external_created_by: k.external_created_by ?? null,
      external_created_by_email: k.external_created_by_email ?? null,
      spend_attribution: k.spend_attribution ?? null,
      assignment_source: k.assignment_source ?? null,
      external_status: k.external_status ?? null,
      unresolved_reason: k.unresolved_reason ?? null,
      observed: !!s,
      total_cost_usd: round6(s?.total ?? 0),
      record_count: s?.count ?? 0,
      last_seen: s?.last ?? null,
    })
  }
  for (const [key, s] of seen) {
    if (rows.has(key)) continue
    const [provider_id, external_key_id] = key.split(SEP)
    rows.set(key, {
      provider_id,
      external_key_id,
      name: s.name,
      id: null,
      owner_person_id: null,
      team_id: null,
      org_project_id: null,
      observed_project_id: keyProject.get(key) ?? null,
      observed_workspace_id: keyWorkspace.get(key) ?? null,
      external_created_by: null,
      external_created_by_email: null,
      spend_attribution: null,
      assignment_source: null,
      external_status: null,
      unresolved_reason: null,
      observed: true,
      total_cost_usd: round6(s.total),
      record_count: s.count,
      last_seen: s.last,
    })
  }
  return [...rows.values()].sort(bySpend)
}

/**
 * AI Gateway keys nobody has assigned yet: no owner, no team and no project
 * (neither on the key nor from a project-scoped key's rows). Their spend sits
 * in Unassigned until an admin assigns a person, project or team.
 */
export function unassignedGatewayKeys(keys: KeyRow[], gatewayProviderId: string | null | undefined): KeyRow[] {
  if (!gatewayProviderId) return []
  return keys.filter(
    (k) =>
      k.provider_id === gatewayProviderId &&
      !k.owner_person_id &&
      !k.team_id &&
      !k.org_project_id &&
      !k.observed_project_id
  )
}

/**
 * Every project seen in attribution.project_id, plus every Anthropic workspace
 * seen in attribution.workspace_id (issue #28, kind "workspace"; they share
 * org_projects, keyed by provider + external id), merged with registered
 * org_projects.
 */
export function listProjects(records: ObservedRecord[], registered: OrgProject[]): ProjectRow[] {
  const seen = new Map<string, Seen>()
  const workspaces = new Set<string>()
  for (const r of records) {
    const a = attributionOf(r)
    if (a?.project_id) {
      bump(seen, pkey(r.provider_id, a.project_id), r, a.project_name)
      // Anthropic rows name their workspace as the project too (issue #32).
      if (a.workspace_id === a.project_id) workspaces.add(pkey(r.provider_id, a.project_id))
    } else if (a?.workspace_id) {
      bump(seen, pkey(r.provider_id, a.workspace_id), r, null)
      workspaces.add(pkey(r.provider_id, a.workspace_id))
    }
  }
  const rows = new Map<string, ProjectRow>()
  for (const p of registered) {
    const s = seen.get(pkey(p.provider_id, p.external_project_id))
    rows.set(pkey(p.provider_id, p.external_project_id), {
      provider_id: p.provider_id,
      external_project_id: p.external_project_id,
      kind: workspaces.has(pkey(p.provider_id, p.external_project_id)) ? "workspace" : "project",
      name: p.name ?? s?.name ?? null,
      id: p.id,
      team_id: p.team_id,
      observed: !!s,
      total_cost_usd: round6(s?.total ?? 0),
      record_count: s?.count ?? 0,
      last_seen: s?.last ?? null,
    })
  }
  for (const [key, s] of seen) {
    if (rows.has(key)) continue
    const [provider_id, external_project_id] = key.split(SEP)
    rows.set(key, {
      provider_id,
      external_project_id,
      kind: workspaces.has(key) ? "workspace" : "project",
      name: s.name,
      id: null,
      team_id: null,
      observed: true,
      total_cost_usd: round6(s.total),
      record_count: s.count,
      last_seen: s.last,
    })
  }
  return [...rows.values()].sort(bySpend)
}

// ---------------------------------------------------------------------------
// Unassigned queue
// ---------------------------------------------------------------------------

/**
 * Which handle a group is assigned by. Each unassigned record lands in exactly
 * one group, chosen in attribution order: person (email), then API key, then
 * project. "other" has nothing assignable (no attribution, or workspace only).
 */
export type UnassignedKind = "person" | "api_key" | "project" | "other"

export interface UnassignedGroup {
  kind: UnassignedKind
  /** Stable key: email, or provider_id + ":" + external id, or "other". */
  key: string
  label: string
  provider_ids: string[]
  person_id: string | null
  email: string | null
  provider_id: string | null
  external_id: string | null
  /** org_api_keys.id / org_projects.id when the key or project is registered. */
  registered_id: string | null
  total_cost_usd: number
  record_count: number
}

export interface UnassignedQueue {
  month: string
  /** All spend in the month. */
  org_total_usd: number
  /** Spend with no team (sum of every group). */
  unassigned_total_usd: number
  subtotals: Record<UnassignedKind, number>
  groups: UnassignedGroup[]
}

export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 1))
  return { start: start.toISOString(), end: end.toISOString() }
}

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7)
}

/** Group a month's records that resolve to no team. `records` should already be limited to the month. */
export function buildUnassignedQueue(records: ObservedRecord[], org: OrgSnapshot, month: string): UnassignedQueue {
  const index = buildOrgIndex(orgDataOf(org))
  const groups = new Map<string, UnassignedGroup & { providers: Set<string>; total: number }>()
  const subtotals: Record<UnassignedKind, number> = { person: 0, api_key: 0, project: 0, other: 0 }
  let orgTotal = 0
  let unassignedTotal = 0

  for (const r of records) {
    const cost = num(r.cost_usd)
    orgTotal += cost
    const metadata = { attribution: r.attribution }
    const resolved = resolveAttribution({ provider_id: r.provider_id, metadata }, index)
    if (resolved.team_id) continue
    unassignedTotal += cost

    const a = getAttribution(metadata)
    const person = resolved.person_id ? index.peopleById.get(resolved.person_id) : undefined
    const email = person?.email ?? a?.person_email ?? null

    let g: Omit<UnassignedGroup, "provider_ids" | "total_cost_usd" | "record_count">
    if (email) {
      g = {
        kind: "person",
        key: email,
        label: person?.display_name || a?.person_name || email,
        person_id: person?.id ?? null,
        email,
        provider_id: null,
        external_id: null,
        registered_id: null,
      }
    } else if (a?.api_key_id) {
      const k = index.apiKeys.get(pkey(r.provider_id, a.api_key_id))
      g = {
        kind: "api_key",
        key: `${r.provider_id}:${a.api_key_id}`,
        label: k?.name || a.api_key_name || a.api_key_id,
        person_id: null,
        email: null,
        provider_id: r.provider_id,
        external_id: a.api_key_id,
        registered_id: k?.id ?? null,
      }
    } else if (a?.project_id) {
      const p = index.projects?.get(pkey(r.provider_id, a.project_id))
      g = {
        kind: "project",
        key: `${r.provider_id}:${a.project_id}`,
        label: p?.name || a.project_name || a.project_id,
        person_id: null,
        email: null,
        provider_id: r.provider_id,
        external_id: a.project_id,
        registered_id: p?.id ?? null,
      }
    } else {
      g = {
        kind: "other",
        key: "other",
        label: "No assignable attribution",
        person_id: null,
        email: null,
        provider_id: null,
        external_id: null,
        registered_id: null,
      }
    }

    const mapKey = `${g.kind}|${g.key}`
    let group = groups.get(mapKey)
    if (!group) {
      group = { ...g, provider_ids: [], providers: new Set(), total: 0, total_cost_usd: 0, record_count: 0 }
      groups.set(mapKey, group)
    }
    group.providers.add(r.provider_id)
    group.total += cost
    group.record_count += 1
    subtotals[g.kind] += cost
  }

  const out: UnassignedGroup[] = [...groups.values()]
    .map(({ providers, total, ...rest }) => ({
      ...rest,
      provider_ids: [...providers].sort(),
      total_cost_usd: round6(total),
    }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd || a.key.localeCompare(b.key))

  return {
    month,
    org_total_usd: round6(orgTotal),
    unassigned_total_usd: round6(unassignedTotal),
    subtotals: {
      person: round6(subtotals.person),
      api_key: round6(subtotals.api_key),
      project: round6(subtotals.project),
      other: round6(subtotals.other),
    },
    groups: out,
  }
}
