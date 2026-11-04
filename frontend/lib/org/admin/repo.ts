/**
 * Data access for the admin org routes (service-role client).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { refreshDailyAggregates } from "@/lib/supabase/admin"
import { HttpError, must } from "./http"
import type { ObservedRecord } from "./observed"
import type { OrgSnapshot } from "./schemas"

/** org_api_keys columns; the 015 ones are dropped when the migration isn't applied yet. */
export const KEY_COLUMNS_BASE = "id, provider_id, external_key_id, name, owner_person_id, team_id"
export const KEY_COLUMNS_015 =
  "org_project_id, external_created_by, external_created_by_email, spend_attribution, assignment_source"
export const KEY_COLUMNS = `${KEY_COLUMNS_BASE}, ${KEY_COLUMNS_015}`
/** Migration 017 (issue #32): Anthropic key status and why the sync left a key without an owner. */
export const KEY_COLUMNS_017 = `${KEY_COLUMNS}, external_status, unresolved_reason`
/** Migration 018 (issue #44): the provider's key creation date, shown by issue #45 when present. */
export const KEY_COLUMNS_018 = `${KEY_COLUMNS_017}, provider_created_at`

/** True for PostgREST / Postgres "column does not exist" (migration 015 not applied). */
export function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204" || /column .* does not exist/i.test(error.message ?? ""))
}

async function loadKeys(admin: SupabaseClient): Promise<{ data: unknown[] | null; error: { code?: string; message: string } | null }> {
  // Newest column set first; fall back while 018 / 017 / 015 aren't applied.
  for (const columns of [KEY_COLUMNS_018, KEY_COLUMNS_017, KEY_COLUMNS, KEY_COLUMNS_BASE]) {
    const res = await admin.from("org_api_keys").select(columns as string)
    if (columns === KEY_COLUMNS_BASE || !isMissingColumn(res.error)) return res
  }
  throw new Error("unreachable")
}

export async function loadOrg(admin: SupabaseClient): Promise<OrgSnapshot> {
  const [departments, teams, people, identities, apiKeys, projects, providers] = await Promise.all([
    admin.from("departments").select("id, name, description, created_at, updated_at").order("name"),
    admin.from("teams").select("id, name, department_id, created_at, updated_at").order("name"),
    admin.from("people").select("id, email, display_name, team_id, active, created_at, updated_at").order("email"),
    admin.from("person_identities").select("id, person_id, provider_id, external_id"),
    loadKeys(admin),
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
  requireField?: "person_email" | "api_key_id" | "project_id" | "workspace_id"
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
