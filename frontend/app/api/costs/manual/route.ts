/**
 * Manual Cost Entry API Route
 *
 * POST /api/costs/manual - Add manual cost entry (e.g., ChatGPT, Claude Desktop)
 *
 * Request Body:
 * {
 *   provider_id: string (UUID)
 *   timestamp: string (ISO datetime)
 *   model_name: string
 *   cost_usd: number
 *   tokens_used?: number
 *   input_tokens?: number
 *   output_tokens?: number
 *   request_count?: number (default: 1)
 *   metadata?: object
 * }
 *
 * For bulk imports (e.g., CSV), send:
 * {
 *   entries: [ ...array of entries... ]
 * }
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import {
  ManualCostEntrySchema,
  BulkCostEntrySchema,
  parseBody,
} from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const cookieStore = await cookies()
    const userId = await requireAuth(cookieStore)

    // Parse request body
    const body = await request.json()

    // Check if bulk or single entry
    const isBulk = "entries" in body

    if (isBulk) {
      return await handleBulkEntry(userId, body, cookieStore)
    } else {
      return await handleSingleEntry(userId, body, cookieStore)
    }
  } catch (error: any) {
    console.error("POST /api/costs/manual error:", error)

    if (error.message === "Unauthorized") {
      return errorResponse("Unauthorized", 401)
    }

    return errorResponse(error.message || "Failed to create manual cost entry", 400)
  }
}

/**
 * Handle single manual entry
 */
async function handleSingleEntry(
  userId: string,
  body: any,
  cookieStore: Awaited<ReturnType<typeof cookies>>
) {
  // Validate body
  const entry = ManualCostEntrySchema.parse(body)

  // Create Supabase client
  const supabase = await createClient(cookieStore)

  // Verify provider exists
  const { data: provider, error: providerError } = await supabase
    .from("providers")
    .select("id, name")
    .eq("id", entry.provider_id)
    .single()

  if (providerError || !provider) {
    throw new Error("Invalid provider_id")
  }

  // Insert cost record
  const { data, error } = await supabase
    .from("cost_records")
    .insert({
      user_id: userId,
      provider_id: entry.provider_id,
      timestamp: entry.timestamp,
      model_name: entry.model_name,
      cost_usd: entry.cost_usd,
      tokens_used: entry.tokens_used || null,
      input_tokens: entry.input_tokens || null,
      output_tokens: entry.output_tokens || null,
      request_count: entry.request_count,
      collection_method: "manual_entry",
      metadata: entry.metadata,
    })
    .select()
    .single()

  if (error) {
    console.error("Insert error:", error)
    throw new Error("Failed to insert cost record")
  }

  return successResponse(
    {
      message: "Manual cost entry created successfully",
      data,
    },
    201
  )
}

/**
 * Handle bulk manual entries (e.g., CSV import)
 */
async function handleBulkEntry(
  userId: string,
  body: any,
  cookieStore: Awaited<ReturnType<typeof cookies>>
) {
  // Validate body
  const bulkData = BulkCostEntrySchema.parse(body)

  // Create Supabase client
  const supabase = await createClient(cookieStore)

  // Get unique provider IDs and verify they all exist
  const providerIds = [...new Set(bulkData.entries.map((e) => e.provider_id))]

  const { data: providers, error: providerError } = await supabase
    .from("providers")
    .select("id")
    .in("id", providerIds)

  if (providerError || !providers || providers.length !== providerIds.length) {
    throw new Error("One or more invalid provider_id values")
  }

  // Prepare records for bulk insert
  const records = bulkData.entries.map((entry) => ({
    user_id: userId,
    provider_id: entry.provider_id,
    timestamp: entry.timestamp,
    model_name: entry.model_name,
    cost_usd: entry.cost_usd,
    tokens_used: entry.tokens_used || null,
    input_tokens: entry.input_tokens || null,
    output_tokens: entry.output_tokens || null,
    request_count: entry.request_count,
    collection_method: "csv_import",
    metadata: entry.metadata,
  }))

  // Bulk insert (Supabase supports up to 1000 rows per insert)
  const { data, error, count } = await supabase
    .from("cost_records")
    .insert(records)
    .select()

  if (error) {
    console.error("Bulk insert error:", error)
    throw new Error(`Failed to insert cost records: ${error.message}`)
  }

  return successResponse(
    {
      message: `Successfully imported ${count || records.length} cost records`,
      count: count || records.length,
      data,
    },
    201
  )
}
