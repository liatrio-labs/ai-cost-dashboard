/**
 * Org structure and attribution types (issue #5, epic #4).
 *
 * `Attribution` is the shared contract collectors write to
 * cost_records.metadata.attribution (#6) and the rollup reads (#5).
 * Entity types mirror the tables in database/migrations/010_org_structure.sql.
 */

export const ATTRIBUTION_GRANULARITIES = [
  "person",
  "api_key",
  "project",
  "workspace",
  "org",
] as const

export type AttributionGranularity = (typeof ATTRIBUTION_GRANULARITIES)[number]

/** cost_records.metadata.attribution. Every field is optional; set only what the provider returns. */
export interface Attribution {
  person_email?: string | null // lower-cased
  person_external_id?: string | null // provider's user / actor id
  person_name?: string | null
  api_key_id?: string | null // provider's stable key id (never the secret)
  api_key_name?: string | null
  project_id?: string | null // OpenAI project, Vercel project
  project_name?: string | null
  workspace_id?: string | null // Anthropic workspace
  granularity: AttributionGranularity
}

export interface Department {
  id: string
  name: string
  description?: string | null
  created_at?: string
  updated_at?: string
}

export interface Team {
  id: string
  name: string
  department_id: string | null
  created_at?: string
  updated_at?: string
}

/** Not an auth.users row: most people never sign in. `email` is lower-cased. */
export interface Person {
  id: string
  email: string
  display_name?: string | null
  team_id: string | null
  active?: boolean
  created_at?: string
  updated_at?: string
}

/** Maps a provider user/actor id (or an email the provider reports) to a person. */
export interface PersonIdentity {
  id?: string
  person_id: string
  provider_id: string
  external_id: string
}

/** Provider API key metadata. Never holds the secret. */
export interface OrgApiKey {
  id: string
  provider_id: string
  external_key_id: string
  name?: string | null
  owner_person_id: string | null
  team_id: string | null
  /** Project this key's spend belongs to (migration 015). Optional so pre-015 callers keep working. */
  org_project_id?: string | null
  /** Provider user id that created the key (AI Gateway createdBy, 015). */
  external_created_by?: string | null
  external_created_by_email?: string | null
  /** AI Gateway spendAttribution: "user" | "team"; null = unset (team). */
  spend_attribution?: string | null
  /** auto = set by the key sync; manual = set by an admin (never overwritten); null = nothing assigned. */
  assignment_source?: "auto" | "manual" | null
}

/** Provider project metadata (migration 011) with the team that owns its spend. */
export interface OrgProject {
  id: string
  provider_id: string
  external_project_id: string
  name?: string | null
  team_id: string | null
}

export interface OrgData {
  departments: Department[]
  teams: Team[]
  people: Person[]
  identities: PersonIdentity[]
  apiKeys: OrgApiKey[]
  /** org_projects (011). Optional so callers built before 011 keep working. */
  projects?: OrgProject[]
}

/** Lookup maps built once from OrgData (see buildOrgIndex). */
export interface OrgIndex {
  departmentsById: Map<string, Department>
  teamsById: Map<string, Team>
  peopleById: Map<string, Person>
  peopleByEmail: Map<string, Person>
  /** key: providerId + "\u0000" + external_id */
  identities: Map<string, PersonIdentity>
  /** key: providerId + "\u0000" + external_key_id */
  apiKeys: Map<string, OrgApiKey>
  apiKeysById: Map<string, OrgApiKey>
  /** key: providerId + "\u0000" + external_project_id (011; optional for hand-built indexes) */
  projects?: Map<string, OrgProject>
  /** org_projects.id -> project (015 key projects; optional for hand-built indexes) */
  projectsById?: Map<string, OrgProject>
}

/** The parts of a cost_records row attribution needs. */
export interface AttributableRecord {
  provider_id: string
  metadata?: Record<string, unknown> | null
}

/** Result of resolveAttribution. A null id means Unassigned at that level. */
export interface ResolvedAttribution {
  person_id: string | null
  org_api_key_id: string | null
  team_id: string | null
  department_id: string | null
  project_id: string | null
  workspace_id: string | null
  granularity: AttributionGranularity
}

/** A cost_records_daily_attributed row. Numeric columns may arrive as strings from PostgREST. */
export interface AttributedDailyRow extends ResolvedAttribution {
  date: string
  provider_id: string
  model_name: string
  total_cost_usd: number | string
  total_tokens?: number | string | null
  total_input_tokens?: number | string | null
  total_output_tokens?: number | string | null
  total_requests?: number | string | null
  record_count?: number | string | null
}
