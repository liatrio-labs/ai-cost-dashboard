/**
 * Dashboard filters (issue #8). Filter state lives in the URL query so views
 * are shareable; the same parser runs in the browser and in the API routes.
 *
 *   ?department=<id>|unassigned &team=<id>|unassigned &person=<id>|unassigned
 *   &key=<org_api_keys.id>|unassigned &provider=<providers.id>
 *
 * Filters combine with AND. "unassigned" matches rows with no entity at that
 * level (the Unassigned bucket).
 */

import { UNASSIGNED_KEY } from "@/lib/org/rollup"
import type { ResolvedAttribution } from "@/lib/org/types"

export interface DashboardFilters {
  department?: string
  team?: string
  person?: string
  key?: string
  provider?: string
}

export const FILTER_PARAMS = ["department", "team", "person", "key", "provider"] as const
export type FilterParam = (typeof FILTER_PARAMS)[number]

/** Org-level filters in drill-down order. */
export const ORG_FILTER_PARAMS = ["department", "team", "person", "key"] as const

const FIELD: Record<FilterParam, keyof FilterableRow> = {
  department: "department_id",
  team: "team_id",
  person: "person_id",
  key: "org_api_key_id",
  provider: "provider_id",
}

/** Ids are UUIDs in production; fixtures use short slugs. Anything else is dropped. */
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/

type ParamSource = { get(name: string): string | null }

export function parseFilters(params: ParamSource): DashboardFilters {
  const out: DashboardFilters = {}
  for (const name of FILTER_PARAMS) {
    const v = params.get(name)?.trim()
    if (v && ID_PATTERN.test(v)) out[name] = v
  }
  return out
}

export function hasFilters(f: DashboardFilters): boolean {
  return FILTER_PARAMS.some((p) => !!f[p])
}

export type FilterableRow = Pick<
  ResolvedAttribution,
  "department_id" | "team_id" | "person_id" | "org_api_key_id"
> & { provider_id: string }

export function matchesFilters(row: FilterableRow, f: DashboardFilters): boolean {
  for (const name of FILTER_PARAMS) {
    const want = f[name]
    if (!want) continue
    const have = row[FIELD[name]] ?? null
    if (want === UNASSIGNED_KEY ? have !== null : have !== want) return false
  }
  return true
}

export function applyFilters<T extends FilterableRow>(rows: T[], f: DashboardFilters): T[] {
  return hasFilters(f) ? rows.filter((r) => matchesFilters(r, f)) : rows
}

/** The period part of the query (month | start+end), passed through untouched. */
export interface PeriodParams {
  month?: string | null
  start?: string | null
  end?: string | null
}

export function parsePeriod(params: ParamSource): PeriodParams {
  return { month: params.get("month"), start: params.get("start"), end: params.get("end") }
}

/** Build a query string ("" or "?a=b&...") from a period and filters. */
export function toQueryString(period: PeriodParams, filters: DashboardFilters): string {
  const qs = new URLSearchParams()
  if (period.start && period.end) {
    qs.set("start", period.start)
    qs.set("end", period.end)
  } else if (period.month) {
    qs.set("month", period.month)
  }
  for (const name of FILTER_PARAMS) {
    const v = filters[name]
    if (v) qs.set(name, v)
  }
  const s = qs.toString()
  return s ? `?${s}` : ""
}
