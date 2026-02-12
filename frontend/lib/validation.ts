/**
 * Zod validation schemas for API routes
 *
 * These schemas ensure type safety and validation for all API requests.
 */

import { z } from "zod"

// ============================================================================
// Query Parameter Schemas
// ============================================================================

export const CostQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  providers: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(",") : undefined)),
  granularity: z.enum(["hour", "day", "week", "month"]).optional().default("day"),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined)),
})

export type CostQuery = z.infer<typeof CostQuerySchema>

export const SummaryQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  providers: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(",") : undefined)),
})

export type SummaryQuery = z.infer<typeof SummaryQuerySchema>

// ============================================================================
// Request Body Schemas
// ============================================================================

export const ManualCostEntrySchema = z.object({
  provider_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  model_name: z.string().min(1).max(100),
  cost_usd: z.number().positive().max(999999),
  tokens_used: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  request_count: z.number().int().positive().default(1),
  metadata: z.record(z.any()).optional().default({}),
})

export type ManualCostEntry = z.infer<typeof ManualCostEntrySchema>

export const BulkCostEntrySchema = z.object({
  entries: z.array(ManualCostEntrySchema).min(1).max(1000),
})

export type BulkCostEntry = z.infer<typeof BulkCostEntrySchema>

export const AddCredentialSchema = z.object({
  provider_id: z.string().uuid(),
  credential_name: z.string().min(1).max(100),
  api_key: z.string().min(10),
  metadata: z.record(z.any()).optional().default({}),
})

export type AddCredential = z.infer<typeof AddCredentialSchema>

export const UpdateCredentialSchema = z.object({
  credential_name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
})

export type UpdateCredential = z.infer<typeof UpdateCredentialSchema>

export const BackfillRequestSchema = z.object({
  start_date: z.string().datetime(),
  end_date: z.string().datetime(),
  force: z.boolean().optional().default(false),
})

export type BackfillRequest = z.infer<typeof BackfillRequestSchema>

// ============================================================================
// Response Schemas
// ============================================================================

export const CostRecordSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  provider_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  model_name: z.string(),
  cost_usd: z.number(),
  tokens_used: z.number().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  request_count: z.number(),
  collection_method: z.string(),
  metadata: z.record(z.any()),
  created_at: z.string().datetime(),
})

export type CostRecord = z.infer<typeof CostRecordSchema>

export const CostSummarySchema = z.object({
  total_cost: z.number(),
  total_requests: z.number(),
  total_tokens: z.number(),
  avg_cost_per_request: z.number(),
  avg_cost_per_token: z.number(),
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
  by_provider: z.array(
    z.object({
      provider_id: z.string().uuid(),
      provider_name: z.string(),
      total_cost: z.number(),
      total_requests: z.number(),
      percentage: z.number(),
    })
  ),
  by_model: z.array(
    z.object({
      model_name: z.string(),
      total_cost: z.number(),
      total_requests: z.number(),
      percentage: z.number(),
    })
  ),
  top_cost_day: z
    .object({
      date: z.string(),
      cost: z.number(),
    })
    .nullable(),
})

export type CostSummary = z.infer<typeof CostSummarySchema>

export const ProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  display_name: z.string(),
  api_base_url: z.string().nullable(),
  documentation_url: z.string().nullable(),
  is_active: z.boolean(),
  metadata: z.record(z.any()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export type Provider = z.infer<typeof ProviderSchema>

export const CredentialSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  provider_id: z.string().uuid(),
  credential_name: z.string(),
  encrypted_api_key: z.string(),
  is_active: z.boolean(),
  last_validated_at: z.string().datetime().nullable(),
  validation_status: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  provider: ProviderSchema.optional(),
})

export type Credential = z.infer<typeof CredentialSchema>

export const ErrorResponseSchema = z.object({
  error: z.string(),
  details: z.any().optional(),
})

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Parse and validate request body
 */
export async function parseBody<T>(request: Request, schema: z.ZodSchema<T>): Promise<T> {
  try {
    const body = await request.json()
    return schema.parse(body)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Validation error: ${error.errors.map((e) => e.message).join(", ")}`)
    }
    throw new Error("Invalid request body")
  }
}

/**
 * Parse and validate URL search params
 */
export function parseSearchParams<T>(url: URL, schema: z.ZodSchema<T>): T {
  try {
    const params = Object.fromEntries(url.searchParams.entries())
    return schema.parse(params)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Validation error: ${error.errors.map((e) => e.message).join(", ")}`)
    }
    throw new Error("Invalid query parameters")
  }
}

/**
 * Date range validation helper
 */
export function validateDateRange(
  startDate: string | undefined,
  endDate: string | undefined
): { start: Date; end: Date } {
  const end = endDate ? new Date(endDate) : new Date()
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000) // Default 30 days

  if (start > end) {
    throw new Error("Start date must be before end date")
  }

  if (end > new Date()) {
    throw new Error("End date cannot be in the future")
  }

  const maxRange = 365 * 24 * 60 * 60 * 1000 // 1 year
  if (end.getTime() - start.getTime() > maxRange) {
    throw new Error("Date range cannot exceed 1 year")
  }

  return { start, end }
}
