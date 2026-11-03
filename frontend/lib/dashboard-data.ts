/**
 * Supabase reads shared by /api/dashboard and /api/dashboard/breakdown.
 * Server-only (takes an authenticated server client); RLS applies.
 */

import type { ProviderRow } from "@/lib/dashboard-compute"
import {
  FILTER_FIELD,
  ORG_FILTER_KEYS,
  UNASSIGNED_FILTER,
  type DashboardFilters,
} from "@/lib/dashboard-filters"
import type { AttributedDailyRow, OrgData } from "@/lib/org/types"

// Minimal structural types so tests can pass a fake client.
interface QueryResult {
  data: unknown[] | null
  error: unknown
}
export interface Query extends PromiseLike<QueryResult> {
  order(column: string, options?: { ascending?: boolean }): Query
  range(from: number, to: number): Query
  eq(column: string, value: unknown): Query
  is(column: string, value: null): Query
}
export interface SupabaseLike {
  from(table: string): { select(columns: string): Query }
}

const PAGE = 1000

/**
 * PostgREST caps each request at ~1000 rows, so page through with .range()
 * until everything is fetched. `narrow` adds filters to each page's query.
 */
export async function fetchAllPaged<T>(
  supabase: SupabaseLike,
  table: string,
  columns: string,
  narrow: (q: Query) => Query = (q) => q
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await narrow(supabase.from(table).select(columns))
      .order("date", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data || []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export async function fetchProviders(supabase: SupabaseLike): Promise<ProviderRow[]> {
  const { data, error } = await supabase
    .from("providers")
    .select("id, name, display_name, documentation_url, last_collected_at, metadata")
    .order("display_name")
  if (error) throw error
  return (data || []) as ProviderRow[]
}

export const ATTRIBUTED_COLUMNS =
  "date, provider_id, model_name, person_id, org_api_key_id, team_id, department_id, project_id, workspace_id, granularity, total_cost_usd, total_tokens, total_requests, record_count"

/**
 * Push filters down to PostgREST so a narrow view doesn't page through the
 * whole org. Callers still apply matchesFilters in memory (cheap, and keeps
 * the pure path the single source of truth).
 */
export function narrowAttributed(f: DashboardFilters, providerId: string | null) {
  return (q: Query): Query => {
    for (const k of ORG_FILTER_KEYS) {
      const v = f[k]
      if (!v) continue
      q = v === UNASSIGNED_FILTER ? q.is(FILTER_FIELD[k], null) : q.eq(FILTER_FIELD[k], v)
    }
    if (f.provider && providerId) q = q.eq("provider_id", providerId)
    return q
  }
}

export async function fetchAttributedDaily(
  supabase: SupabaseLike,
  f: DashboardFilters,
  providerId: string | null
): Promise<AttributedDailyRow[]> {
  // An unknown provider slug matches nothing; skip the round trips.
  if (f.provider && !providerId) return []
  return fetchAllPaged<AttributedDailyRow>(
    supabase,
    "cost_records_daily_attributed",
    ATTRIBUTED_COLUMNS,
    narrowAttributed(f, providerId)
  )
}

/** Org tables (authenticated SELECT, migrations 010/011). Identities aren't needed for labels. */
export async function fetchOrgData(supabase: SupabaseLike): Promise<OrgData> {
  const [departments, teams, people, apiKeys, projects] = await Promise.all([
    supabase.from("departments").select("id, name, description").order("name"),
    supabase.from("teams").select("id, name, department_id").order("name"),
    supabase.from("people").select("id, email, display_name, team_id, active").order("email"),
    supabase.from("org_api_keys").select("id, provider_id, external_key_id, name, owner_person_id, team_id").order("name"),
    supabase.from("org_projects").select("id, provider_id, external_project_id, name, team_id").order("name"),
  ])
  for (const r of [departments, teams, people, apiKeys, projects]) if (r.error) throw r.error
  return {
    departments: (departments.data || []) as OrgData["departments"],
    teams: (teams.data || []) as OrgData["teams"],
    people: (people.data || []) as OrgData["people"],
    identities: [],
    apiKeys: (apiKeys.data || []) as OrgData["apiKeys"],
    projects: (projects.data || []) as NonNullable<OrgData["projects"]>,
  }
}

export function providerIdForSlug(providers: ProviderRow[], slug: string | undefined): string | null {
  if (!slug) return null
  return providers.find((p) => p.name === slug)?.id ?? null
}
