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

/**
 * Refresh the cost_records_daily materialized view (the rollup the dashboard
 * reads). Call after writing cost_records so new data shows immediately instead
 * of waiting for the every-15-minutes refresh-aggregates cron. Best-effort: logs
 * and swallows errors so a refresh failure never fails the write that triggered it.
 */
export async function refreshDailyAggregates(): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.rpc("refresh_cost_records_daily")
    if (error) console.error("refreshDailyAggregates failed:", error.message)
  } catch (e) {
    console.error("refreshDailyAggregates threw:", e instanceof Error ? e.message : e)
  }
}
