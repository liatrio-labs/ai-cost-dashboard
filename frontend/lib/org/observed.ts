/**
 * Pure helpers for the admin org screens (issue #7): what cost_records
 * actually observed (people, API keys) and the Unassigned queue.
 *
 * Attribution is resolved with resolveAttribution from ./attribution, so the
 * queue agrees exactly with cost_records_daily_attributed.
 */

import { buildOrgIndex, getAttribution, resolveAttribution } from "./attribution"
import type { OrgData, OrgIndex } from "./types"

/** The cost_records columns these helpers read. */
export interface ObservedRecord {
  provider_id: string
  timestamp: string
  cost_usd: number | string
  metadata?: Record<string, unknown> | null
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

function num(value: number | string | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

const SEP = "\u0000"

// ---------------------------------------------------------------------------
// People observed in metadata.attribution.person_email
// ---------------------------------------------------------------------------

export interface ObservedPerson {
  email: string
  /** Most recent person_name seen for this email. */
  name: string | null
  provider_ids: string[]
  record_count: number
  total_cost_usd: number
  first_seen: string
  last_seen: string
  /** id of the people row with this email, or null if it would be created. */
  existing_person_id: string | null
}

/** Distinct person_email values, sorted by email. */
export function observedPeople(records: ObservedRecord[], org: OrgData): ObservedPerson[] {
  const index = buildOrgIndex(org)
  const byEmail = new Map<string, ObservedPerson & { providers: Set<string>; nameAt: string }>()
  for (const r of records) {
    const attr = getAttribution(r.metadata)
    const email = attr?.person_email
    if (!email) continue
    let p = byEmail.get(email)
    if (!p) {
      p = {
        email,
        name: null,
        nameAt: "",
        provider_ids: [],
        providers: new Set(),
        record_count: 0,
        total_cost_usd: 0,
        first_seen: r.timestamp,
        last_seen: r.timestamp,
        existing_person_id: index.peopleByEmail.get(email)?.id ?? null,
      }
      byEmail.set(email, p)
    }
    p.providers.add(r.provider_id)
    p.record_count += 1
    p.total_cost_usd += num(r.cost_usd)
    if (r.timestamp < p.first_seen) p.first_seen = r.timestamp
    if (r.timestamp > p.last_seen) p.last_seen = r.timestamp
    if (attr.person_name && r.timestamp >= p.nameAt) {
      p.name = attr.person_name
      p.nameAt = r.timestamp
    }
  }
  return [...byEmail.values()]
    .map((p): ObservedPerson => ({
      email: p.email,
      name: p.name,
      provider_ids: [...p.providers].sort(),
      record_count: p.record_count,
      total_cost_usd: round6(p.total_cost_usd),
      first_seen: p.first_seen,
      last_seen: p.last_seen,
      existing_person_id: p.existing_person_id,
    }))
    .sort((a, b) => a.email.localeCompare(b.email))
}

// ---------------------------------------------------------------------------
// API keys: observed in metadata.attribution.api_key_id plus registered rows
// ---------------------------------------------------------------------------

export interface ApiKeyListing {
  provider_id: string
  external_key_id: string
  name: string | null
  /** org_api_keys.id, or null when the key is only observed. */
  id: string | null
  owner_person_id: string | null
  team_id: string | null
  registered: boolean
  observed: boolean
  record_count: number
  total_cost_usd: number
  last_seen: string | null
}

/** Every observed key merged with every registered key, highest spend first. */
export function listApiKeys(records: ObservedRecord[], org: OrgData): ApiKeyListing[] {
  const keys = new Map<string, ApiKeyListing>()
  for (const k of org.apiKeys) {
    keys.set(`${k.provider_id}${SEP}${k.external_key_id}`, {
      provider_id: k.provider_id,
      external_key_id: k.external_key_id,
      name: k.name ?? null,
      id: k.id,
      owner_person_id: k.owner_person_id,
      team_id: k.team_id,
      registered: true,
      observed: false,
      record_count: 0,
      total_cost_usd: 0,
      last_seen: null,
    })
  }
  for (const r of records) {
    const attr = getAttribution(r.metadata)
    const keyId = attr?.api_key_id
    if (!keyId) continue
    const mapKey = `${r.provider_id}${SEP}${keyId}`
    let k = keys.get(mapKey)
    if (!k) {
      k = {
        provider_id: r.provider_id,
        external_key_id: keyId,
        name: null,
        id: null,
        owner_person_id: null,
        team_id: null,
        registered: false,
        observed: true,
        record_count: 0,
        total_cost_usd: 0,
        last_seen: null,
      }
      keys.set(mapKey, k)
    }
    k.observed = true
    k.record_count += 1
    k.total_cost_usd += num(r.cost_usd)
    if (!k.last_seen || r.timestamp > k.last_seen) {
      k.last_seen = r.timestamp
      // A registered name wins; otherwise keep the latest observed name.
      if (!k.registered && attr.api_key_name) k.name = attr.api_key_name
    } else if (!k.name && attr.api_key_name) {
      k.name = attr.api_key_name
    }
  }
  return [...keys.values()]
    .map((k) => ({ ...k, total_cost_usd: round6(k.total_cost_usd) }))
    .sort(
      (a, b) =>
        b.total_cost_usd - a.total_cost_usd ||
        a.provider_id.localeCompare(b.provider_id) ||
        a.external_key_id.localeCompare(b.external_key_id)
    )
}

// ---------------------------------------------------------------------------
// Unassigned queue: spend that resolves to no team
// ---------------------------------------------------------------------------

/**
 * person:  a person email (known person without a team, or an email no person
 *          has yet). Assign = set (or create) the person with a team.
 * api_key: a key id with no owner person and no team. Assign = register the
 *          key with a team.
 * project: project-only spend (no person, no key). Not assignable: the #5
 *          resolver has no project -> team mapping.
 * other:   nothing to assign on (org-level rows, workspace-only rows, or an
 *          external user id with no identity mapping).
 */
export type UnassignedKind = "person" | "api_key" | "project" | "other"

export interface UnassignedGroup {
  kind: UnassignedKind
  /** Stable group key, e.g. "person:alice@x.com" or "api_key:<provider>:<key>". */
  key: string
  label: string
  provider_ids: string[]
  email: string | null
  person_id: string | null
  external_key_id: string | null
  /** Set for api_key groups (one provider per key). */
  provider_id: string | null
  project_id: string | null
  total_cost_usd: number
  record_count: number
  assignable: boolean
  /** Why the group can't be assigned in one click, when it can't. */
  reason: string | null
}

export interface UnassignedQueue {
  /** All spend in the window. */
  total_cost_usd: number
  /** Spend that resolves to a team. */
  assigned_cost_usd: number
  /** Spend that resolves to no team; equals the sum of the groups. */
  unassigned_cost_usd: number
  groups: UnassignedGroup[]
}

type Mutable = UnassignedGroup & { providers: Set<string> }

function newGroup(partial: Pick<UnassignedGroup, "kind" | "key" | "label"> & Partial<UnassignedGroup>): Mutable {
  return {
    email: null,
    person_id: null,
    external_key_id: null,
    provider_id: null,
    project_id: null,
    total_cost_usd: 0,
    record_count: 0,
    assignable: true,
    reason: null,
    provider_ids: [],
    providers: new Set(),
    ...partial,
  }
}

function groupFor(record: ObservedRecord, personId: string | null, index: OrgIndex): Mutable {
  const attr = getAttribution(record.metadata)
  const person = personId ? index.peopleById.get(personId) : undefined
  if (person) {
    return newGroup({
      kind: "person",
      key: `person:${person.email}`,
      label: person.display_name || person.email,
      email: person.email,
      person_id: person.id,
    })
  }
  if (attr?.person_email) {
    return newGroup({
      kind: "person",
      key: `person:${attr.person_email}`,
      label: attr.person_name || attr.person_email,
      email: attr.person_email,
    })
  }
  if (attr?.api_key_id) {
    const registered = index.apiKeys.get(`${record.provider_id}${SEP}${attr.api_key_id}`)
    return newGroup({
      kind: "api_key",
      key: `api_key:${record.provider_id}:${attr.api_key_id}`,
      label: registered?.name || attr.api_key_name || attr.api_key_id,
      external_key_id: attr.api_key_id,
      provider_id: record.provider_id,
    })
  }
  if (attr?.project_id) {
    return newGroup({
      kind: "project",
      key: `project:${record.provider_id}:${attr.project_id}`,
      label: attr.project_name || attr.project_id,
      provider_id: record.provider_id,
      project_id: attr.project_id,
      assignable: false,
      reason: "Project-only spend has no person or API key to assign; the org model has no project-to-team mapping yet.",
    })
  }
  return newGroup({
    kind: "other",
    key: "other",
    label: "No person, API key or project",
    assignable: false,
    reason: attr?.person_external_id
      ? "Map the provider user id to a person (identity mapping) to attribute this spend."
      : "Org-level spend with no attribution.",
  })
}

export function unassignedQueue(records: ObservedRecord[], org: OrgData): UnassignedQueue {
  const index = buildOrgIndex(org)
  const groups = new Map<string, Mutable>()
  let total = 0
  let assigned = 0
  for (const r of records) {
    const cost = num(r.cost_usd)
    total += cost
    const resolved = resolveAttribution(r, index)
    if (resolved.team_id) {
      assigned += cost
      continue
    }
    const candidate = groupFor(r, resolved.person_id, index)
    const g = groups.get(candidate.key) ?? candidate
    groups.set(candidate.key, g)
    g.total_cost_usd += cost
    g.record_count += 1
    g.providers.add(r.provider_id)
  }
  const list = [...groups.values()]
    .map(({ providers, ...g }) => ({
      ...g,
      provider_ids: [...providers].sort(),
      total_cost_usd: round6(g.total_cost_usd),
    }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd || a.key.localeCompare(b.key))
  return {
    total_cost_usd: round6(total),
    assigned_cost_usd: round6(assigned),
    unassigned_cost_usd: round6(total - assigned),
    groups: list,
  }
}

/** [start, end) ISO bounds for a YYYY-MM month in UTC. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 1))
  return { start: start.toISOString(), end: end.toISOString() }
}

export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7)
}
