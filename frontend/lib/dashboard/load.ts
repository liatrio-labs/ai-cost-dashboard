/**
 * Server-side loaders shared by the dashboard API routes.
 */

import type { AttributedDailyRow, OrgData } from "@/lib/org/types"

// Minimal structural type for the bits of the Supabase client we use.
type QueryResult = PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>
interface Query extends QueryResult {
  select(cols: string): Query
  order(col: string, opts?: { ascending?: boolean }): Query
  range(from: number, to: number): QueryResult
}
export interface SupabaseLike {
  from(table: string): Query
}

/**
 * PostgREST caps each request at ~1000 rows, so page through with .range()
 * until everything is fetched.
 */
export async function fetchAllRows<T>(supabase: SupabaseLike, table: string, columns: string, orderBy = "date"): Promise<T[]> {
  const out: T[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data || []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export const ATTRIBUTED_COLUMNS =
  "date, provider_id, model_name, person_id, org_api_key_id, team_id, department_id, project_id, workspace_id, granularity, total_cost_usd, total_tokens, total_requests, record_count"

export function fetchAttributedRows(supabase: SupabaseLike): Promise<AttributedDailyRow[]> {
  return fetchAllRows<AttributedDailyRow>(supabase, "cost_records_daily_attributed", ATTRIBUTED_COLUMNS)
}

/**
 * Org structure for labels and filter options. Identities aren't needed here
 * (the materialized view already resolved them). A missing or unreadable
 * table reads as empty, so the dashboard degrades to "everything Unassigned"
 * rather than failing.
 */
export async function loadOrgData(supabase: SupabaseLike): Promise<OrgData> {
  const read = async <T>(table: string, cols: string, orderBy: string): Promise<T[]> => {
    try {
      return await fetchAllRows<T>(supabase, table, cols, orderBy)
    } catch {
      return []
    }
  }
  const [departments, teams, people, apiKeys] = await Promise.all([
    read<OrgData["departments"][number]>("departments", "id, name", "name"),
    read<OrgData["teams"][number]>("teams", "id, name, department_id", "name"),
    read<OrgData["people"][number]>("people", "id, email, display_name, team_id, active", "email"),
    read<OrgData["apiKeys"][number]>("org_api_keys", "id, provider_id, external_key_id, name, owner_person_id, team_id", "name"),
  ])
  return { departments, teams, people, identities: [], apiKeys }
}
