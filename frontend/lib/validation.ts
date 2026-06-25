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
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
})

export type ManualCostEntry = z.infer<typeof ManualCostEntrySchema>

export const BulkCostEntrySchema = z.object({
  entries: z.array(ManualCostEntrySchema).min(1).max(1000),
})

export type BulkCostEntry = z.infer<typeof BulkCostEntrySchema>

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
      // @ts-ignore - ZodError type inference issue
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
      // @ts-ignore - ZodError type inference issue
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
