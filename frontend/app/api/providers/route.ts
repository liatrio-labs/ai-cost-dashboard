/**
 * Providers and API Credentials Management API Route
 *
 * GET /api/providers - List all providers with user's credentials
 * POST /api/providers - Add new API credential for a provider
 * DELETE /api/providers?credential_id=xxx - Revoke an API credential
 *
 * Note: Actual encryption/decryption happens in the Python backend.
 * This route calls the backend API to store encrypted credentials.
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { createClient, requireAuth, errorResponse, successResponse } from "@/lib/db"
import { AddCredentialSchema, parseBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

/**
 * GET - List all providers with user's credentials
 */
export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const cookieStore = await cookies()
    const userId = await requireAuth(cookieStore)

    // Create Supabase client
    const supabase = await createClient(cookieStore)

    // Get all active providers
    const { data: providers, error: providersError } = await supabase
      .from("providers")
      .select("*")
      .eq("is_active", true)
      .order("display_name")

    if (providersError) throw providersError

    // Get user's credentials for each provider
    const { data: credentials, error: credentialsError } = await supabase
      .from("api_credentials")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (credentialsError) throw credentialsError

    // Mask API keys (show only last 4 chars)
    const maskedCredentials = (credentials || []).map((cred) => ({
      ...cred,
      encrypted_api_key: "***encrypted***",
      masked_key: maskApiKey(cred.encrypted_api_key),
    }))

    // Combine providers with credentials
    const providersWithCredentials = (providers || []).map((provider) => ({
      ...provider,
      credentials: maskedCredentials.filter((c) => c.provider_id === provider.id),
    }))

    return successResponse(providersWithCredentials)
  } catch (error: any) {
    console.error("GET /api/providers error:", error)

    if (error.message === "Unauthorized") {
      return errorResponse("Unauthorized", 401)
    }

    return errorResponse(error.message || "Failed to fetch providers", 500)
  }
}

/**
 * POST - Add new API credential
 *
 * This proxies to the Python backend for encryption
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const cookieStore = await cookies()
    const userId = await requireAuth(cookieStore)

    // Parse and validate body
    const body = await parseBody(request, AddCredentialSchema)

    // Create Supabase client
    const supabase = await createClient(cookieStore)

    // Verify provider exists
    const { data: provider, error: providerError } = await supabase
      .from("providers")
      .select("id, name")
      .eq("id", body.provider_id)
      .single()

    if (providerError || !provider) {
      throw new Error("Invalid provider_id")
    }

    // Call Python backend to encrypt and store the API key
    const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

    const response = await fetch(`${backendUrl}/api/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        provider_id: body.provider_id,
        credential_name: body.credential_name,
        api_key: body.api_key,
        metadata: body.metadata,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.detail || "Failed to store credential")
    }

    const data = await response.json()

    return successResponse(
      {
        message: "API credential added successfully",
        credential: {
          ...data,
          encrypted_api_key: "***encrypted***",
        },
      },
      201
    )
  } catch (error: any) {
    console.error("POST /api/providers error:", error)

    if (error.message === "Unauthorized") {
      return errorResponse("Unauthorized", 401)
    }

    return errorResponse(error.message || "Failed to add credential", 400)
  }
}

/**
 * DELETE - Revoke an API credential
 */
export async function DELETE(request: NextRequest) {
  try {
    // Authenticate user
    const cookieStore = await cookies()
    const userId = await requireAuth(cookieStore)

    // Get credential_id from query params
    const { searchParams } = new URL(request.url)
    const credentialId = searchParams.get("credential_id")

    if (!credentialId) {
      throw new Error("credential_id query parameter is required")
    }

    // Create Supabase client
    const supabase = await createClient(cookieStore)

    // Verify credential belongs to user
    const { data: credential, error: fetchError } = await supabase
      .from("api_credentials")
      .select("id, user_id")
      .eq("id", credentialId)
      .eq("user_id", userId)
      .single()

    if (fetchError || !credential) {
      throw new Error("Credential not found or unauthorized")
    }

    // Deactivate the credential (soft delete)
    const { error: updateError } = await supabase
      .from("api_credentials")
      .update({ is_active: false })
      .eq("id", credentialId)

    if (updateError) throw updateError

    return successResponse({
      message: "API credential revoked successfully",
      credential_id: credentialId,
    })
  } catch (error: any) {
    console.error("DELETE /api/providers error:", error)

    if (error.message === "Unauthorized") {
      return errorResponse("Unauthorized", 401)
    }

    return errorResponse(error.message || "Failed to revoke credential", 400)
  }
}

/**
 * Helper to mask API key (show last 4 chars)
 */
function maskApiKey(key: string): string {
  if (!key || key.length < 8) {
    return "***"
  }
  return `***${key.slice(-4)}`
}
