/**
 * API keys table filters (issue #45). Pure: shared by the dashboard API keys
 * table (components/org/org-breakdown.tsx) and the /admin/org "API keys by
 * project" card (app/admin/org/keys-by-project.tsx).
 *
 * - Spend filter: by default only keys with spend in the table's period
 *   (non-zero, so a refund still counts as activity) are shown; "show all"
 *   lists $0 keys too.
 * - Search: case-insensitive; every whitespace-separated term must appear in
 *   the key's name, owner or id.
 * - Status chips: active / inactive / deleted (Anthropic "archived"), plus
 *   "no status" for providers that don't report one. Chip counts reflect the
 *   spend filter and search, so they say what selecting the chip would show.
 * - Filters never reorder: kept keys stay in the caller's order (its sort).
 * - "Consider revoking": active keys with $0 in the last 90 days. Read-only.
 */

import type { ProviderGroup } from "./key-groups"

export const KEY_STATUSES = ["active", "inactive", "deleted", "unknown"] as const
export type KeyStatus = (typeof KEY_STATUSES)[number]

export const KEY_STATUS_LABEL: Record<KeyStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  deleted: "Deleted",
  unknown: "No status",
}

/** A provider's key status (org_api_keys.external_status) as a chip. */
export function keyStatus(raw: string | null | undefined): KeyStatus {
  const s = raw?.trim().toLowerCase()
  if (!s) return "unknown"
  if (s === "active") return "active"
  if (s === "archived" || s === "deleted") return "deleted"
  return "inactive"
}

export interface KeyFilter {
  /** false (default): hide keys with $0 spend in the period. */
  showAll: boolean
  query: string
  status: KeyStatus | "all"
}

export const DEFAULT_KEY_FILTER: KeyFilter = { showAll: false, query: "", status: "all" }

/** What the filters read from a key; callers map their own row shape. */
export interface KeyFilterFields {
  /** Spend in the table's period. */
  spend: number
  /** Raw provider status, e.g. "active", "archived", or null. */
  status: string | null | undefined
  /** Searchable text: name, owner, id. */
  text: (string | null | undefined)[]
}

export function matchesQuery(text: (string | null | undefined)[], query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = text.filter(Boolean).join("\n").toLowerCase()
  return terms.every((t) => hay.includes(t))
}

export const hasSpend = (spend: number) => Number.isFinite(spend) && spend !== 0

export interface KeyFilterResult<T> {
  /** Kept keys, in input order. */
  keys: T[]
  /** Every key passed in. */
  total: number
  /** Keys with spend in the period. */
  withSpend: number
  /** Per status: keys passing the spend filter and search. */
  statusCounts: Record<KeyStatus, number>
}

export function filterKeys<T>(keys: T[], filter: KeyFilter, fields: (k: T) => KeyFilterFields): KeyFilterResult<T> {
  const statusCounts: Record<KeyStatus, number> = { active: 0, inactive: 0, deleted: 0, unknown: 0 }
  const kept: T[] = []
  let withSpend = 0
  for (const k of keys) {
    const f = fields(k)
    const spent = hasSpend(f.spend)
    if (spent) withSpend++
    if (!filter.showAll && !spent) continue
    if (!matchesQuery(f.text, filter.query)) continue
    const s = keyStatus(f.status)
    statusCounts[s]++
    if (filter.status !== "all" && filter.status !== s) continue
    kept.push(k)
  }
  return { keys: kept, total: keys.length, withSpend, statusCounts }
}

/** True when the filter differs from the default view. */
export const isFiltered = (f: KeyFilter) => f.showAll || f.query.trim() !== "" || f.status !== "all"

/** "119 of 594 keys with spend", "12 of 594 keys" (show all + search), "594 keys". */
export function keyCountText(r: Pick<KeyFilterResult<unknown>, "keys" | "total">, filter: KeyFilter): string {
  const noun = r.total === 1 ? "key" : "keys"
  const suffix = filter.showAll ? "" : " with spend"
  if (filter.showAll && r.keys.length === r.total) return `${r.total} ${noun}`
  return `${r.keys.length} of ${r.total} ${noun}${suffix}`
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * Keep only `keep`'s keys in grouped output (lib/org/key-groups), dropping
 * empty groups and providers and recomputing subtotals from the kept keys.
 * Order is unchanged.
 */
export function filterGroups<T extends { total_cost_usd: number }>(groups: ProviderGroup<T>[], keep: Set<T>): ProviderGroup<T>[] {
  const out: ProviderGroup<T>[] = []
  for (const pg of groups) {
    const projects = pg.projects
      .map((g) => {
        const keys = g.keys.filter((k) => keep.has(k))
        return { ...g, keys, total_cost_usd: round6(keys.reduce((s, k) => s + k.total_cost_usd, 0)) }
      })
      .filter((g) => g.keys.length > 0)
    if (projects.length === 0) continue
    out.push({ ...pg, projects, total_cost_usd: round6(projects.reduce((s, g) => s + g.total_cost_usd, 0)) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Activity window and "Consider revoking"
// ---------------------------------------------------------------------------

export const REVOKE_WINDOW_DAYS = 90

export interface KeyActivity {
  /** Spend on or after the window start (now - days). */
  spend: number
  /** Latest date (YYYY-MM-DD) with non-zero spend, any time; null = never. */
  lastSpend: string | null
}

/** YYYY-MM-DD of `now` minus `days` (UTC). */
export function windowStart(now: Date, days = REVOKE_WINDOW_DAYS): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Per-key spend in the last `days` days and last spend date, from cost rows
 * ({ key, date: ISO date or timestamp, cost }). Rows after `now` are ignored.
 */
export function keyActivity(
  rows: Iterable<{ key: string | null | undefined; date: string | null | undefined; cost: number }>,
  now: Date,
  days = REVOKE_WINDOW_DAYS
): Map<string, KeyActivity> {
  const start = windowStart(now, days)
  const end = now.toISOString().slice(0, 10)
  const out = new Map<string, KeyActivity>()
  for (const r of rows) {
    if (!r.key || !r.date) continue
    const d = r.date.slice(0, 10)
    if (d > end) continue
    const a = out.get(r.key) ?? { spend: 0, lastSpend: null }
    const cost = Number.isFinite(r.cost) ? r.cost : 0
    if (d >= start) a.spend = round6(a.spend + cost)
    if (cost !== 0 && (!a.lastSpend || d > a.lastSpend)) a.lastSpend = d
    out.set(r.key, a)
  }
  return out
}

export interface RevokeFields {
  status: string | null | undefined
  /** Spend in the last 90 days. */
  spend90d: number
  /** Last date with spend, null = never. */
  lastSpend: string | null
  label: string
}

/**
 * Active keys with $0 in the last 90 days, never-spent first, then the
 * longest idle, then by name. Read-only: the UI offers no revoke action.
 */
export function considerRevoking<T>(keys: T[], fields: (k: T) => RevokeFields): T[] {
  return keys
    .map((k) => ({ k, f: fields(k) }))
    .filter(({ f }) => keyStatus(f.status) === "active" && !hasSpend(f.spend90d))
    .sort(
      (a, b) =>
        Number(a.f.lastSpend !== null) - Number(b.f.lastSpend !== null) ||
        (a.f.lastSpend ?? "").localeCompare(b.f.lastSpend ?? "") ||
        a.f.label.localeCompare(b.f.label)
    )
    .map(({ k }) => k)
}
