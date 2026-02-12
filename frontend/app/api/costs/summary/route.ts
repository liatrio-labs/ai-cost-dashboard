/**
 * Cost Summary API Route
 *
 * GET /api/costs/summary - Get aggregated cost metrics
 *
 * Query Parameters:
 * - startDate: ISO datetime (default: 30 days ago)
 * - endDate: ISO datetime (default: now)
 * - providers: comma-separated provider IDs
 *
 * Returns:
 * - Total cost, requests, tokens
 * - Average cost per request and per token
 * - Breakdown by provider and model
 * - Top cost day
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import { SummaryQuerySchema, parseSearchParams, validateDateRange } from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const cookieStore = await cookies()
    const userId = await requireAuth(cookieStore)

    // Parse and validate query parameters
    const query = parseSearchParams(request.nextUrl, SummaryQuerySchema)

    // Validate date range
    const { start, end } = validateDateRange(query.startDate, query.endDate)

    // Create Supabase client
    const supabase = await createClient(cookieStore)

    // Query cost_records_daily for aggregated data
    let q = supabase
      .from("cost_records_daily")
      .select(
        `
        date,
        provider_id,
        model_name,
        total_cost_usd,
        total_tokens,
        total_input_tokens,
        total_output_tokens,
        total_requests
      `
      )
      .eq("user_id", userId)
      .gte("date", start.toISOString().split("T")[0])
      .lte("date", end.toISOString().split("T")[0])

    // Filter by providers if specified
    if (query.providers && query.providers.length > 0) {
      q = q.in("provider_id", query.providers)
    }

    const { data: records, error } = await q

    if (error) throw error

    if (!records || records.length === 0) {
      return successResponse({
        total_cost: 0,
        total_requests: 0,
        total_tokens: 0,
        avg_cost_per_request: 0,
        avg_cost_per_token: 0,
        period_start: start.toISOString(),
        period_end: end.toISOString(),
        by_provider: [],
        by_model: [],
        top_cost_day: null,
      })
    }

    // Calculate totals
    let totalCost = 0
    let totalRequests = 0
    let totalTokens = 0

    const byProvider = new Map<string, { cost: number; requests: number }>()
    const byModel = new Map<string, { cost: number; requests: number }>()
    const byDay = new Map<string, number>()

    for (const record of records) {
      totalCost += record.total_cost_usd
      totalRequests += record.total_requests
      totalTokens += record.total_tokens

      // By provider
      const providerKey = record.provider_id
      if (!byProvider.has(providerKey)) {
        byProvider.set(providerKey, { cost: 0, requests: 0 })
      }
      const providerData = byProvider.get(providerKey)!
      providerData.cost += record.total_cost_usd
      providerData.requests += record.total_requests

      // By model
      const modelKey = record.model_name
      if (!byModel.has(modelKey)) {
        byModel.set(modelKey, { cost: 0, requests: 0 })
      }
      const modelData = byModel.get(modelKey)!
      modelData.cost += record.total_cost_usd
      modelData.requests += record.total_requests

      // By day
      const dayKey = record.date
      byDay.set(dayKey, (byDay.get(dayKey) || 0) + record.total_cost_usd)
    }

    // Calculate averages
    const avgCostPerRequest = totalRequests > 0 ? totalCost / totalRequests : 0
    const avgCostPerToken = totalTokens > 0 ? totalCost / totalTokens : 0

    // Get provider names
    const providerIds = Array.from(byProvider.keys())
    const { data: providers } = await supabase
      .from("providers")
      .select("id, display_name")
      .in("id", providerIds)

    const providerMap = new Map<string, string>()
    if (providers) {
      for (const provider of providers) {
        providerMap.set(provider.id, provider.display_name)
      }
    }

    // Format by_provider
    const byProviderArray = Array.from(byProvider.entries())
      .map(([id, data]) => ({
        provider_id: id,
        provider_name: providerMap.get(id) || "Unknown",
        total_cost: Number(data.cost.toFixed(6)),
        total_requests: data.requests,
        percentage: Number(((data.cost / totalCost) * 100).toFixed(2)),
      }))
      .sort((a, b) => b.total_cost - a.total_cost)

    // Format by_model
    const byModelArray = Array.from(byModel.entries())
      .map(([model, data]) => ({
        model_name: model,
        total_cost: Number(data.cost.toFixed(6)),
        total_requests: data.requests,
        percentage: Number(((data.cost / totalCost) * 100).toFixed(2)),
      }))
      .sort((a, b) => b.total_cost - a.total_cost)
      .slice(0, 10) // Top 10 models

    // Find top cost day
    let topCostDay = null
    if (byDay.size > 0) {
      const topDay = Array.from(byDay.entries()).reduce((max, current) =>
        current[1] > max[1] ? current : max
      )
      topCostDay = {
        date: topDay[0],
        cost: Number(topDay[1].toFixed(6)),
      }
    }

    return successResponse({
      total_cost: Number(totalCost.toFixed(6)),
      total_requests: totalRequests,
      total_tokens: totalTokens,
      avg_cost_per_request: Number(avgCostPerRequest.toFixed(6)),
      avg_cost_per_token: Number(avgCostPerToken.toFixed(8)),
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      by_provider: byProviderArray,
      by_model: byModelArray,
      top_cost_day: topCostDay,
    })
  } catch (error: any) {
    console.error("GET /api/costs/summary error:", error)

    if (error.message === "Unauthorized") {
      return errorResponse("Unauthorized", 401)
    }

    return errorResponse(error.message || "Failed to fetch cost summary", 500)
  }
}
