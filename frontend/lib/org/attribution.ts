/**
 * Pure attribution resolution. Mirrors cost_records_daily_attributed in
 * database/migrations/011_org_projects.sql (which recreates the 010 view)
 * exactly; change both together.
 *
 * 1. Person: person_email = people.email (case-insensitive); else
 *    (provider, person_external_id) in identities; else (provider, person_email)
 *    in identities; else the API key's owner; else none.
 * 2. Team: the API key's team; else the person's team; else the project's
 *    team (org_projects, migration 011); else none.
 * 3. Department: the team's department; else none.
 *
 * Empty strings count as absent. Emails are trimmed and lower-cased; external
 * ids and key ids match exactly. Membership is current-state only.
 */

import {
  ATTRIBUTION_GRANULARITIES,
  type AttributableRecord,
  type Attribution,
  type AttributionGranularity,
  type OrgData,
  type OrgIndex,
  type ResolvedAttribution,
} from "./types"

const SEP = "\u0000"
const providerKey = (providerId: string, id: string) => `${providerId}${SEP}${id}`

/** Non-empty string or null (matches SQL NULLIF(x, '')). */
function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/** Trimmed, lower-cased email or null (matches SQL NULLIF(lower(btrim(x)), '')). */
export function normalizeEmail(value: unknown): string | null {
  return typeof value === "string" ? str(value.trim().toLowerCase()) : null
}

function isGranularity(value: unknown): value is AttributionGranularity {
  return (ATTRIBUTION_GRANULARITIES as readonly unknown[]).includes(value)
}

/**
 * Read metadata.attribution defensively. Returns null when absent or not an
 * object; an unknown or missing granularity becomes "org".
 */
export function getAttribution(metadata: unknown): Attribution | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null
  const raw = (metadata as Record<string, unknown>).attribution
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const a = raw as Record<string, unknown>
  return {
    person_email: normalizeEmail(a.person_email),
    person_external_id: str(a.person_external_id),
    person_name: str(a.person_name),
    api_key_id: str(a.api_key_id),
    api_key_name: str(a.api_key_name),
    project_id: str(a.project_id),
    project_name: str(a.project_name),
    workspace_id: str(a.workspace_id),
    granularity: isGranularity(a.granularity) ? a.granularity : "org",
  }
}

export function buildOrgIndex(data: OrgData): OrgIndex {
  const index: OrgIndex = {
    departmentsById: new Map(data.departments.map((d) => [d.id, d])),
    teamsById: new Map(data.teams.map((t) => [t.id, t])),
    peopleById: new Map(data.people.map((p) => [p.id, p])),
    peopleByEmail: new Map(),
    identities: new Map(),
    apiKeys: new Map(),
    apiKeysById: new Map(data.apiKeys.map((k) => [k.id, k])),
    projects: new Map(),
  }
  for (const p of data.people) {
    const email = normalizeEmail(p.email)
    if (email) index.peopleByEmail.set(email, p)
  }
  for (const i of data.identities) {
    if (i.external_id) index.identities.set(providerKey(i.provider_id, i.external_id), i)
  }
  for (const k of data.apiKeys) {
    if (k.external_key_id) index.apiKeys.set(providerKey(k.provider_id, k.external_key_id), k)
  }
  for (const pr of data.projects ?? []) {
    if (pr.external_project_id) index.projects!.set(providerKey(pr.provider_id, pr.external_project_id), pr)
  }
  return index
}

export function resolveAttribution(record: AttributableRecord, index: OrgIndex): ResolvedAttribution {
  const attr = getAttribution(record.metadata)
  const email = attr?.person_email ?? null
  const externalId = attr?.person_external_id ?? null
  const keyId = attr?.api_key_id ?? null

  const apiKey = keyId ? index.apiKeys.get(providerKey(record.provider_id, keyId)) : undefined

  const personId =
    (email ? index.peopleByEmail.get(email)?.id : undefined) ??
    (externalId ? index.identities.get(providerKey(record.provider_id, externalId))?.person_id : undefined) ??
    (email ? index.identities.get(providerKey(record.provider_id, email))?.person_id : undefined) ??
    apiKey?.owner_person_id ??
    null

  const person = personId ? index.peopleById.get(personId) : undefined
  const projectId = attr?.project_id ?? null
  const project = projectId ? index.projects?.get(providerKey(record.provider_id, projectId)) : undefined
  const teamId = apiKey?.team_id ?? person?.team_id ?? project?.team_id ?? null
  const departmentId = teamId ? (index.teamsById.get(teamId)?.department_id ?? null) : null

  return {
    person_id: personId,
    org_api_key_id: apiKey?.id ?? null,
    team_id: teamId,
    department_id: departmentId,
    project_id: projectId,
    workspace_id: attr?.workspace_id ?? null,
    granularity: attr?.granularity ?? "org",
  }
}
