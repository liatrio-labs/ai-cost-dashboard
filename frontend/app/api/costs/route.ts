/**
 * Cost Records API Route
 *
 * GET /api/costs - Query cost records with filters
 *
 * Query Parameters:
 * - startDate: ISO datetime (default: 30 days ago)
 * - endDate: ISO datetime (default: now)
 * - providers: comma-separated provider IDs
 * - granularity: hour | day | week | month (default: day)
 * - limit: max records to return
 *
 * Returns cost records aggregated by the specified granularity.
 * Uses cost_records_daily materialized view for day granularity for performance.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import { CostQuerySchema, parseSearchParams, validateDateRange } from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const cookieStore = await cookies()
    const userId = await requireAuth(cookieStore)

    // Parse and validate query parameters
    const query = parseSearchParams(request.nextUrl, CostQuerySchema)

    // Validate date range
    const { start, end } = validateDateRange(query.startDate, query.endDate)

    // Create Supabase client
    const supabase = await createClient(cookieStore)

    // Build base query based on granularity
    let data: any[] = []

    if (query.granularity === "day") {
      // Use materialized view for day granularity (much faster)
      let q = supabase
        .from("cost_records_daily")
        .select(
          `
          date,
          user_id,
          provider_id,
          model_name,
          total_cost_usd,
          total_tokens,
          total_input_tokens,
          total_output_tokens,
          total_requests,
          record_count
        `
        )
        .eq("user_id", userId)
        .gte("date", start.toISOString().split("T")[0])
        .lte("date", end.toISOString().split("T")[0])
        .order("date", { ascending: false })

      // Filter by providers if specified
      if (query.providers && query.providers.length > 0) {
        q = q.in("provider_id", query.providers)
      }

      // Apply limit
      if (query.limit) {
        q = q.limit(query.limit)
      }

      const { data: records, error } = await q

      if (error) throw error

      data = records || []
    } else {
      // For hour/week/month granularity, query raw cost_records and aggregate
      let q = supabase
        .from("cost_records")
        .select(
          `
          id,
          user_id,
          provider_id,
          timestamp,
          model_name,
          cost_usd,
          tokens_used,
          input_tokens,
          output_tokens,
          request_count,
          collection_method,
          metadata,
          created_at
        `
        )
        .eq("user_id", userId)
        .gte("timestamp", start.toISOString())
        .lte("timestamp", end.toISOString())
        .order("timestamp", { ascending: false })

      // Filter by providers if specified
      if (query.providers && query.providers.length > 0) {
        q = q.in("provider_id", query.providers)
      }

      // Apply limit
      if (query.limit) {
        q = q.limit(query.limit)
      }

      const { data: records, error } = await q

      if (error) throw error

      data = records || []

      // Aggregate data based on granularity
      if (query.granularity !== "hour" && data.length > 0) {
        data = aggregateByGranularity(data, query.granularity as "week" | "month")
      }
    }

    return successResponse({
      data,
      count: data.length,
      granularity: query.granularity,
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
    })
  } catch (error: any) {
    console.error("GET /api/costs error:", error)

    if (error.message === "Unauthorized") {
      return errorResponse("Unauthorized", 401)
    }

    return errorResponse(error.message || "Failed to fetch cost records", 500)
  }
}

/**
 * Aggregate cost records by week or month
 */
function aggregateByGranularity(
  records: any[],
  granularity: "week" | "month"
): any[] {
  const groups = new Map<string, any>()

  for (const record of records) {
    const date = new Date(record.timestamp)
    let key: string

    if (granularity === "week") {
      // Get start of week (Sunday)
      const startOfWeek = new Date(date)
      startOfWeek.setDate(date.getDate() - date.getDay())
      key = startOfWeek.toISOString().split("T")[0]
    } else {
      // month
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`
    }

    const groupKey = `${key}-${record.provider_id}-${record.model_name}`

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        period_start: key,
        provider_id: record.provider_id,
        model_name: record.model_name,
        total_cost_usd: 0,
        total_tokens: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_requests: 0,
        record_count: 0,
      })
    }

    const group = groups.get(groupKey)!
    group.total_cost_usd += record.cost_usd || 0
    group.total_tokens += record.tokens_used || 0
    group.total_input_tokens += record.input_tokens || 0
    group.total_output_tokens += record.output_tokens || 0
    group.total_requests += record.request_count || 0
    group.record_count += 1
  }

  return Array.from(groups.values()).sort((a, b) =>
    b.period_start.localeCompare(a.period_start)
  )
}
