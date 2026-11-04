/**
 * Duplicate person records (issue #51): find likely duplicates and preview a
 * merge. Pure: the routes (app/api/admin/org/people/duplicates and
 * .../people/merge) load the data, and the merge itself runs in SQL as
 * merge_people() (database/migrations/021_person_merge.sql), which moves
 * exactly what planPersonMerge counts:
 *
 *   - person_identities of the secondary -> the primary
 *   - org_api_keys owned by the secondary -> the primary
 *   - manual seat rows (issue #26) assigned to the secondary's email -> the
 *     primary's email
 *   - one alias identity per provider (secondary email -> primary) where that
 *     provider doesn't already map the email, so automated rows that still
 *     carry the old email resolve to the primary
 *   - the primary adopts the secondary's team / name only where its own is empty
 *
 * Then the secondary is deleted and logged in person_merges. Spend totals
 * never change; the secondary's spend lands on the primary.
 *
 * Likely duplicates: people with the same normalized display name, or the
 * same email local-part (before "@", ignoring "+tag", case and dots).
 * Overlapping matches form one group.
 */

import { normalizeEmail } from "./attribution"
import { isSeatEntry } from "./seat-assignments"

export interface MergePerson {
  id: string
  email: string
  display_name?: string | null
  team_id: string | null
  active?: boolean
  created_at?: string
}

export interface MergeIdentity {
  id?: string
  person_id: string
  provider_id: string
  external_id: string
}

export interface MergeKey {
  id: string
  owner_person_id: string | null
}

export interface MergeOrg {
  people: MergePerson[]
  identities: MergeIdentity[]
  apiKeys: MergeKey[]
  providers: { id: string; name?: string | null; display_name?: string | null }[]
}

/** A cost_records row as the routes load it for seat counting. */
export interface MergeSeatRow {
  id: string
  collection_method: string
  metadata: Record<string, unknown> | null
}

export type DuplicateReason = { kind: "name"; value: string } | { kind: "email_local_part"; value: string }

export interface DuplicateMember {
  id: string
  email: string
  display_name: string | null
  team_id: string | null
  active: boolean
  identities: number
  keys: number
}

export interface DuplicateGroup {
  /** Stable id: the members' ids, sorted and joined. */
  key: string
  reasons: DuplicateReason[]
  /** Suggested primary first (see suggestPrimary), then by email. */
  members: DuplicateMember[]
  suggestedPrimaryId: string
}

export interface MergeCounts {
  identities_moved: number
  keys_moved: number
  seat_rows_moved: number
  aliases_added: number
  team_adopted: boolean
  display_name_adopted: boolean
}

export interface MergePreview extends MergeCounts {
  primary: DuplicateMember
  secondary: DuplicateMember
  /** The primary as it will look afterwards. */
  result: { email: string; display_name: string | null; team_id: string | null; active: boolean }
}

/** The JSONB merge_people() returns. */
export interface MergeResult extends MergeCounts {
  already_merged: boolean
  primary_id: string
  secondary_id: string
  secondary_email: string
  merged_at?: string
}

export class MergePlanError extends Error {
  constructor(public status: 400 | 404, message: string) {
    super(message)
    this.name = "MergePlanError"
  }
}

/** Lower-case, strip accents and punctuation, collapse spaces. "" when nothing is left. */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** "Jane.Doe+cursor@x.com" -> "janedoe". "" for an unusable address. */
export function emailLocalPart(email: string | null | undefined): string {
  const e = normalizeEmail(email ?? "")
  if (!e) return ""
  const at = e.lastIndexOf("@")
  const local = (at > 0 ? e.slice(0, at) : e).split("+")[0].replace(/\./g, "")
  return local.length >= 2 ? local : ""
}

function member(p: MergePerson, org: MergeOrg): DuplicateMember {
  return {
    id: p.id,
    email: p.email,
    display_name: p.display_name ?? null,
    team_id: p.team_id,
    active: p.active !== false,
    identities: org.identities.filter((i) => i.person_id === p.id).length,
    keys: org.apiKeys.filter((k) => k.owner_person_id === p.id).length,
  }
}

/**
 * The record to keep: active, then on a team, then the most linked
 * (identities + keys), then the oldest, then by email.
 */
export function suggestPrimary(members: (DuplicateMember & { created_at?: string })[]): DuplicateMember {
  return [...members].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(!!b.team_id) - Number(!!a.team_id) ||
      b.identities + b.keys - (a.identities + a.keys) ||
      (a.created_at ?? "").localeCompare(b.created_at ?? "") ||
      a.email.localeCompare(b.email)
  )[0]
}

export function findLikelyDuplicates(org: MergeOrg): DuplicateGroup[] {
  const people = org.people
  const parent = new Map(people.map((p) => [p.id, p.id]))
  const find = (id: string): string => {
    let r = id
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(id, r)
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  const byName = new Map<string, string[]>()
  const byLocal = new Map<string, string[]>()
  for (const p of people) {
    const n = normalizeName(p.display_name)
    if (n) byName.set(n, [...(byName.get(n) ?? []), p.id])
    const l = emailLocalPart(p.email)
    if (l) byLocal.set(l, [...(byLocal.get(l) ?? []), p.id])
  }
  for (const ids of [...byName.values(), ...byLocal.values()]) {
    for (const id of ids.slice(1)) union(ids[0], id)
  }

  const groups = new Map<string, MergePerson[]>()
  for (const p of people) {
    const r = find(p.id)
    groups.set(r, [...(groups.get(r) ?? []), p])
  }

  const out: DuplicateGroup[] = []
  for (const ps of groups.values()) {
    if (ps.length < 2) continue
    const ids = new Set(ps.map((p) => p.id))
    const reasons: DuplicateReason[] = []
    for (const [value, list] of byName) if (list.length > 1 && ids.has(list[0])) reasons.push({ kind: "name", value })
    for (const [value, list] of byLocal) if (list.length > 1 && ids.has(list[0])) reasons.push({ kind: "email_local_part", value })
    const members = ps.map((p) => ({ ...member(p, org), created_at: p.created_at }))
    const primary = suggestPrimary(members)
    const sorted = [primary, ...members.filter((m) => m.id !== primary.id).sort((a, b) => a.email.localeCompare(b.email))]
    out.push({
      key: [...ids].sort().join(","),
      reasons,
      members: sorted.map((m) => {
        const copy: DuplicateMember & { created_at?: string } = { ...m }
        delete copy.created_at
        return copy
      }),
      suggestedPrimaryId: primary.id,
    })
  }
  return out.sort((a, b) => a.members[0].email.localeCompare(b.members[0].email))
}

/** Seat rows (issue #26) assigned to `email`; matches merge_people()'s lower(btrim()) test. */
export function seatRowsFor(rows: MergeSeatRow[], email: string): MergeSeatRow[] {
  const want = normalizeEmail(email)
  return rows.filter((r) => {
    if (!isSeatEntry(r)) return false
    const attr = (r.metadata?.attribution ?? null) as { person_email?: unknown } | null
    return typeof attr?.person_email === "string" && normalizeEmail(attr.person_email) === want
  })
}

/** What merge_people(primaryId, secondaryId) would move. Throws MergePlanError for a bad pair. */
export function planPersonMerge(org: MergeOrg, seatRows: MergeSeatRow[], primaryId: string, secondaryId: string): MergePreview {
  if (primaryId === secondaryId) throw new MergePlanError(400, "Pick two different people")
  const primary = org.people.find((p) => p.id === primaryId)
  if (!primary) throw new MergePlanError(404, "Primary person not found")
  const secondary = org.people.find((p) => p.id === secondaryId)
  if (!secondary) throw new MergePlanError(404, "Secondary person not found")

  const email = normalizeEmail(secondary.email)
  // Identities of the secondary move first, so an existing (provider, email)
  // identity of theirs already maps the email and gets no alias.
  const mapped = new Set(org.identities.filter((i) => i.external_id === email).map((i) => i.provider_id))
  const primaryName = (primary.display_name ?? "").trim()
  const secondaryName = (secondary.display_name ?? "").trim()
  const team_adopted = !primary.team_id && !!secondary.team_id
  const display_name_adopted = !primaryName && !!secondaryName

  return {
    primary: member(primary, org),
    secondary: member(secondary, org),
    identities_moved: org.identities.filter((i) => i.person_id === secondaryId).length,
    keys_moved: org.apiKeys.filter((k) => k.owner_person_id === secondaryId).length,
    seat_rows_moved: seatRowsFor(seatRows, secondary.email).length,
    aliases_added: org.providers.filter((p) => !mapped.has(p.id)).length,
    team_adopted,
    display_name_adopted,
    result: {
      email: primary.email,
      display_name: display_name_adopted ? secondary.display_name ?? null : primary.display_name ?? null,
      team_id: primary.team_id ?? secondary.team_id ?? null,
      active: primary.active !== false || secondary.active !== false,
    },
  }
}

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0)

/** Coerce merge_people()'s JSONB into a MergeResult. */
export function parseMergeResult(data: unknown): MergeResult {
  const d = (data ?? {}) as Record<string, unknown>
  return {
    already_merged: d.already_merged === true,
    primary_id: String(d.primary_id ?? ""),
    secondary_id: String(d.secondary_id ?? ""),
    secondary_email: String(d.secondary_email ?? ""),
    ...(typeof d.merged_at === "string" ? { merged_at: d.merged_at } : {}),
    identities_moved: int(d.identities_moved),
    keys_moved: int(d.keys_moved),
    seat_rows_moved: int(d.seat_rows_moved),
    aliases_added: int(d.aliases_added),
    team_adopted: d.team_adopted === true,
    display_name_adopted: d.display_name_adopted === true,
  }
}

/** PostgREST / Postgres "table or function does not exist" (migration 021 not applied). */
export function isMissing021(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return (
    ["42P01", "42883", "PGRST202", "PGRST205"].includes(error.code ?? "") ||
    /(person_merges|merge_people).*(does not exist|could not find)|could not find the (table|function).*(person_merges|merge_people)/i.test(
      error.message ?? ""
    )
  )
}

export const MIGRATION_021_MESSAGE =
  "Migration 021 not applied: merging people needs database/migrations/021_person_merge.sql. Duplicates and previews still work."
