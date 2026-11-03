/**
 * Dashboard filter state (issue #8). Filters live in the URL query so a view
 * is shareable, and the same params are passed through to /api/dashboard and
 * /api/dashboard/breakdown:
 *
 *   ?month=YYYY-MM | ?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   &department=<id|unassigned>&team=<id|unassigned>&person=<id|unassigned>
 *   &key=<org_api_keys.id|unassigned>&project=<external project id|unassigned>
 *   &provider=<providers.name>
 *
 * Filters combine with AND. "unassigned" matches rows with no entity at that
 * level. Drill-downs are just filters: department -> teams -> people ->
 * (provider x model) detail, plus API key and project tables that filter the
 * same way, so breadcrumbs and shared links fall out of the same state.
 * `project` matches the attributed view's project_id: the row's provider
 * project id, else its API key's assigned project (migration 015).
 */

import { UNASSIGNED_KEY } from "@/lib/org/rollup"
import type { ResolvedAttribution } from "@/lib/org/types"

export const UNASSIGNED_FILTER = UNASSIGNED_KEY

export const ORG_FILTER_KEYS = ["department", "team", "person", "key", "project"] as const
export type OrgFilterKey = (typeof ORG_FILTER_KEYS)[number]
export const FILTER_KEYS = [...ORG_FILTER_KEYS, "provider"] as const
export type FilterKey = (typeof FILTER_KEYS)[number]

export type DashboardFilters = Partial<Record<FilterKey, string>>

/** Which attributed-row column each org filter matches. */
export const FILTER_FIELD: Record<
  OrgFilterKey,
  keyof Pick<ResolvedAttribution, "department_id" | "team_id" | "person_id" | "org_api_key_id" | "project_id">
> = {
  department: "department_id",
  team: "team_id",
  person: "person_id",
  key: "org_api_key_id",
  project: "project_id",
}

const MAX_FILTER_LEN = 200

/** Read filters from a query string, ignoring empty or oversized values. */
export function parseFilters(sp: URLSearchParams): DashboardFilters {
  const out: DashboardFilters = {}
  for (const k of FILTER_KEYS) {
    const v = sp.get(k)?.trim()
    if (v && v.length <= MAX_FILTER_LEN) out[k] = v
  }
  return out
}

export function hasFilters(f: DashboardFilters): boolean {
  return FILTER_KEYS.some((k) => !!f[k])
}

export function hasOrgFilters(f: DashboardFilters): boolean {
  return ORG_FILTER_KEYS.some((k) => !!f[k])
}

type FilterableRow = Pick<ResolvedAttribution, "department_id" | "team_id" | "person_id" | "org_api_key_id"> & {
  provider_id: string
  /** Optional so rows built before projects were filterable still type-check (missing = no project). */
  project_id?: string | null
}

/**
 * Does a row pass every filter? `providerIdForFilter` is the provider id the
 * `provider` filter (a slug) resolved to; when the slug is unknown pass null,
 * which matches nothing.
 */
export function matchesFilters(
  row: FilterableRow,
  f: DashboardFilters,
  providerIdForFilter?: string | null
): boolean {
  for (const k of ORG_FILTER_KEYS) {
    const want = f[k]
    if (!want) continue
    const have = row[FILTER_FIELD[k]] ?? null
    if (want === UNASSIGNED_FILTER ? have !== null : have !== want) return false
  }
  if (f.provider && row.provider_id !== providerIdForFilter) return false
  return true
}

export function applyFilters<T extends FilterableRow>(
  rows: T[],
  f: DashboardFilters,
  providerIdForFilter?: string | null
): T[] {
  if (!hasFilters(f)) return rows
  return rows.filter((r) => matchesFilters(r, f, providerIdForFilter))
}

/** The breakdown level to show for the current filters. */
export type DrillLevel = "department" | "team" | "person" | "detail"

export function drillLevel(f: DashboardFilters): DrillLevel {
  if (f.person) return "detail"
  if (f.team) return "person"
  if (f.department) return "team"
  return "department"
}

/** Filters after clicking a row at `level`. Drilling never clears filters above it. */
export function drillInto(f: DashboardFilters, level: Exclude<DrillLevel, "detail">, key: string): DashboardFilters {
  const k: OrgFilterKey = level
  return { ...f, [k]: key }
}

/** Query string (without "?") for the period plus filters, in a stable order. */
export function toQueryString(period: Record<string, string | null | undefined>, f: DashboardFilters): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(period)) if (v) sp.set(k, v)
  for (const k of FILTER_KEYS) if (f[k]) sp.set(k, f[k]!)
  return sp.toString()
}
