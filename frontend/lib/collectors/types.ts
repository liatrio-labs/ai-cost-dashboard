/**
 * Shared types for the TypeScript collection layer.
 *
 * Collectors fetch a provider's cost/usage API and return rows shaped for the
 * cost_records table. The runner attributes them to the owner user and inserts.
 */

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
