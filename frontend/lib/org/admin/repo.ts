/**
 * Data access for the admin org routes (service-role client).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { refreshDailyAggregates } from "@/lib/supabase/admin"
import { HttpError, must } from "./http"
import type { ObservedRecord } from "./observed"
import type { OrgSnapshot } from "./schemas"

export async function loadOrg(admin: SupabaseClient): Promise<OrgSnapshot> {
  const [departments, teams, people, identities, apiKeys, projects, providers] = await Promise.all([
    admin.from("departments").select("id, name, description, created_at, updated_at").order("name"),
    admin.from("teams").select("id, name, department_id, created_at, updated_at").order("name"),
    admin.from("people").select("id, email, display_name, team_id, active, created_at, updated_at").order("email"),
    admin.from("person_identities").select("id, person_id, provider_id, external_id"),
    admin.from("org_api_keys").select("id, provider_id, external_key_id, name, owner_person_id, team_id"),
    admin.from("org_projects").select("id, provider_id, external_project_id, name, team_id"),
    admin.from("providers").select("id, name, display_name").order("name"),
  ])
  return {
    departments: must(departments) ?? [],
    teams: must(teams) ?? [],
    people: must(people) ?? [],
    identities: must(identities) ?? [],
    apiKeys: must(apiKeys) ?? [],
    projects: must(projects) ?? [],
    providers: must(providers) ?? [],
  } as OrgSnapshot
}

export function findOr404<T extends { id: string }>(rows: T[], id: string, label: string): T {
  const row = rows.find((r) => r.id === id)
  if (!row) throw new HttpError(404, `${label} not found`)
  return row
}

const PAGE = 1000
/** Hard stop so a runaway table can't hang a request. */
const MAX_ROWS = 500_000

export interface ScanOptions {
  /** ISO timestamps: start inclusive, end exclusive. */
  start?: string
  end?: string
  /** Only rows whose metadata.attribution.<field> is present. */
  requireField?: "person_email" | "api_key_id" | "project_id"
}

/**
 * Page through cost_records, selecting only the attribution JSON (not the
 * whole metadata blob).
 */
export async function scanRecords(admin: SupabaseClient, opts: ScanOptions = {}): Promise<ObservedRecord[]> {
  const out: ObservedRecord[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let q = admin
      .from("cost_records")
      .select("id, provider_id, timestamp, cost_usd, attribution:metadata->attribution")
    if (opts.start) q = q.gte("timestamp", opts.start)
    if (opts.end) q = q.lt("timestamp", opts.end)
    if (opts.requireField) q = q.not(`metadata->attribution->>${opts.requireField}`, "is", null)
    const page = must(await q.order("id").range(from, from + PAGE - 1)) as unknown as ObservedRecord[]
    out.push(...(page ?? []))
    if (!page || page.length < PAGE) break
  }
  return out
}

/** Attribution changed: refresh the rollups so the dashboard picks it up. Best-effort. */
export async function refreshRollups(): Promise<void> {
  await refreshDailyAggregates()
}
