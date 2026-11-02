/**
 * Shared types for the TypeScript collection layer.
 *
 * Collectors fetch a provider's cost/usage API and return rows shaped for the
 * cost_records table. The runner attributes them to the owner user and inserts.
 */

/**
 * Sub-org attribution for a cost row, stored at `cost_records.metadata.attribution`.
 *
 * This is the shared contract from epic #4. Every field is optional/nullable and
 * a collector sets only what the provider API really returns. `granularity` is
 * the finest dimension the row is attributed to; rows with no `attribution`
 * (pre-#6 data) count as "org" (Unassigned).
 *
 * #5 adds a shared copy under lib/org/; whichever merges second deduplicates.
 */
export type AttributionGranularity = "person" | "api_key" | "project" | "workspace" | "org"

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

export interface CostRecord {
  user_id: string
  provider_id: string
  timestamp: string // ISO 8601, tz-aware
  model_name: string // never null — use a label like "cursor"/"vercel" if no model
  cost_usd: number
  tokens_used: number | null
  input_tokens: number | null
  output_tokens: number | null
  request_count: number
  collection_method: "api_automated"
  metadata: Record<string, unknown>
}

export interface CollectorContext {
  apiKey: string
  userId: string // owner user id
  providerId: string // providers.id for this provider
  organizationId?: string
  teamId?: string
  /** Optional second credential a collector may need (AI Gateway: VERCEL_TOKEN to list keys). */
  auxApiKey?: string
}

export interface CollectOptions {
  backfill?: boolean
  backfillDays?: number
}

export interface Collector {
  provider: string
  collect(ctx: CollectorContext, opts?: CollectOptions): Promise<CostRecord[]>
}

export interface CollectionSummary {
  status: "success" | "skipped" | "error"
  provider: string
  records_collected?: number
  records_stored?: number
  owner_user_id?: string
  reason?: string
  error?: string
  timestamp: string
}
