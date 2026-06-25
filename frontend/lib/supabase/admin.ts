import { createClient, type SupabaseClient } from "@supabase/supabase-js"

/**
 * Service-role Supabase client for server-side collection work (inserting
 * cost_records, resolving the owner user). Bypasses RLS — use only in
 * server-only code (cron routes, admin routes), never in the browser.
 */
export function createAdminClient(): SupabaseClient {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error(
      "Supabase service credentials not configured (need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)"
    )
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
