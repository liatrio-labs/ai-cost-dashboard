/**
 * Backfill API Route
 *
 * POST /api/backfill/[provider] - Trigger historical data collection
 *
 * Request Body:
 * {
 *   start_date: string (ISO datetime)
 *   end_date: string (ISO datetime)
 *   force?: boolean (default: false) - overwrite existing data
 * }
 *
 * This proxies to the Python backend to trigger data collection for a date range.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { requireAuth, errorResponse, successResponse, createClient } from "@/lib/db"
import { BackfillRequestSchema, parseBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    // Authenticate user
    const cookieStore = await cookies()
    const userId = await requireAuth(cookieStore)

    // Get provider from params
    const { provider } = await params

    // Validate provider name
    const validProviders = ["anthropic", "openai"]
    if (!validProviders.includes(provider)) {
      throw new Error(
        `Invalid provider. Must be one of: ${validProviders.join(", ")}`
      )
    }

    // Parse and validate body
    const body = await parseBody(request, BackfillRequestSchema)

    // Validate date range
    const startDate = new Date(body.start_date)
    const endDate = new Date(body.end_date)

    if (startDate > endDate) {
      throw new Error("start_date must be before end_date")
    }

    if (endDate > new Date()) {
      throw new Error("end_date cannot be in the future")
    }

    // Max 90 days backfill
    const maxRange = 90 * 24 * 60 * 60 * 1000
    if (endDate.getTime() - startDate.getTime() > maxRange) {
      throw new Error("Backfill range cannot exceed 90 days")
    }

    // Get provider_id from database
    const supabase = await createClient(cookieStore)
    const { data: providerData, error: providerError } = await supabase
      .from("providers")
      .select("id")
      .eq("name", provider)
      .single()

    if (providerError || !providerData) {
      throw new Error("Provider not found")
    }

    const providerId = (providerData as { id: string }).id

    // Verify user has credentials for this provider
    const { data: credentials, error: credError } = await supabase
      .from("api_credentials")
      .select("id")
      .eq("user_id", userId)
      .eq("provider_id", providerId)
      .eq("is_active", true)
      .limit(1)

    if (credError || !credentials || credentials.length === 0) {
      throw new Error(
        `No active API credentials found for ${provider}. Please add credentials first.`
      )
    }

    // Call Python backend to trigger backfill
    const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

    const response = await fetch(`${backendUrl}/api/backfill/${provider}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        provider_id: providerId,
        start_date: body.start_date,
        end_date: body.end_date,
        force: body.force,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.detail || "Backfill request failed")
    }

    const data = await response.json()

    return successResponse({
      message: `Backfill initiated for ${provider}`,
      ...data,
    })
  } catch (error: any) {
    console.error("POST /api/backfill/[provider] error:", error)

    if (error.message === "Unauthorized") {
      return errorResponse("Unauthorized", 401)
    }

    return errorResponse(error.message || "Failed to initiate backfill", 400)
  }
}
