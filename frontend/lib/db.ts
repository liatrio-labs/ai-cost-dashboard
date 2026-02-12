/**
 * Database utilities for server-side Supabase operations
 *
 * This module provides typed database access with proper authentication context.
 * Use these utilities in API routes to ensure Row-Level Security (RLS) is enforced.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr"
import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"

export type Database = {
  public: {
    Tables: {
      providers: {
        Row: {
          id: string
          name: string
          display_name: string
          api_base_url: string | null
          documentation_url: string | null
          is_active: boolean
          metadata: Record<string, any>
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database["public"]["Tables"]["providers"]["Row"], "id" | "created_at" | "updated_at">
        Update: Partial<Database["public"]["Tables"]["providers"]["Insert"]>
      }
      api_credentials: {
        Row: {
          id: string
          user_id: string
          provider_id: string
          credential_name: string
          encrypted_api_key: string
          encryption_key_id: string
          is_active: boolean
          last_validated_at: string | null
          validation_status: string | null
          metadata: Record<string, any>
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database["public"]["Tables"]["api_credentials"]["Row"], "id" | "created_at" | "updated_at">
        Update: Partial<Database["public"]["Tables"]["api_credentials"]["Insert"]>
      }
      cost_records: {
        Row: {
          id: string
          user_id: string
          provider_id: string
          timestamp: string
          model_name: string
          cost_usd: number
          tokens_used: number | null
          input_tokens: number | null
          output_tokens: number | null
          request_count: number
          collection_method: string
          metadata: Record<string, any>
          created_at: string
        }
        Insert: Omit<Database["public"]["Tables"]["cost_records"]["Row"], "id" | "created_at">
        Update: Partial<Database["public"]["Tables"]["cost_records"]["Insert"]>
      }
      forecast_results: {
        Row: {
          id: string
          user_id: string
          provider_id: string | null
          model_name: string | null
          forecast_date: string
          predicted_cost_usd: number
          lower_bound_80: number | null
          upper_bound_80: number | null
          lower_bound_95: number | null
          upper_bound_95: number | null
          confidence_score: number | null
          model_version: string
          training_data_start: string
          training_data_end: string
          training_record_count: number
          metadata: Record<string, any>
          created_at: string
        }
        Insert: Omit<Database["public"]["Tables"]["forecast_results"]["Row"], "id" | "created_at">
        Update: Partial<Database["public"]["Tables"]["forecast_results"]["Insert"]>
      }
      user_preferences: {
        Row: {
          user_id: string
          currency: string
          timezone: string
          theme: string
          default_date_range: string
          email_notifications: boolean
          forecast_enabled: boolean
          metadata: Record<string, any>
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database["public"]["Tables"]["user_preferences"]["Row"], "created_at" | "updated_at">
        Update: Partial<Database["public"]["Tables"]["user_preferences"]["Insert"]>
      }
    }
    Views: {
      cost_records_daily: {
        Row: {
          user_id: string
          provider_id: string
          date: string
          model_name: string
          total_cost_usd: number
          total_tokens: number
          total_input_tokens: number
          total_output_tokens: number
          total_requests: number
          record_count: number
        }
      }
    }
    Functions: {
      get_user_total_spend: {
        Args: {
          p_user_id: string
          p_start_date: string
          p_end_date: string
        }
        Returns: number
      }
      get_top_models_by_spend: {
        Args: {
          p_user_id: string
          p_start_date: string
          p_end_date: string
          p_limit: number
        }
        Returns: Array<{
          model_name: string
          total_cost: number
          total_tokens: number
          request_count: number
        }>
      }
    }
  }
}

/**
 * Create a Supabase client for use in API routes with cookie-based auth
 */
export async function createClient(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from middleware - cookies are read-only
          }
        },
      },
    }
  )
}

/**
 * Create a Supabase client for use in Route Handlers with request/response
 * This variant handles cookie updates in the response
 */
export function createRouteHandlerClient(
  request: NextRequest,
  response: NextResponse
) {
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )
}

/**
 * Get the currently authenticated user from cookies
 * Returns null if not authenticated
 */
export async function getCurrentUser(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  const supabase = await createClient(cookieStore)
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) {
    return null
  }

  return user
}

/**
 * Verify user is authenticated and return user ID
 * Throws error if not authenticated
 */
export async function requireAuth(cookieStore: Awaited<ReturnType<typeof cookies>>): Promise<string> {
  const user = await getCurrentUser(cookieStore)

  if (!user) {
    throw new Error("Unauthorized")
  }

  return user.id
}

/**
 * Error response helper
 */
export function errorResponse(message: string, status: number = 500) {
  return NextResponse.json({ error: message }, { status })
}

/**
 * Success response helper
 */
export function successResponse<T>(data: T, status: number = 200) {
  return NextResponse.json(data, { status })
}
