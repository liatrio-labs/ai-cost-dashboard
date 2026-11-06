/**
 * Issue #94: the dashboard's existing Supabase Google sign-in, driven from the
 * server for the MCP OAuth flow. No second identity provider: the same
 * Supabase project and Google provider the /login page uses.
 *
 * Every client here is ephemeral (in-memory storage, no cookies), so an MCP
 * sign-in gets its own Supabase session and never reads, refreshes or
 * replaces the browser's dashboard session. The PKCE verifier Supabase keeps
 * between the redirect and the callback travels in the sealed authorize
 * request cookie instead of Supabase's own cookie.
 *
 * Only the public anon key is used. Data reads go through dataClient(), which
 * carries the caller's Supabase access token, so RLS applies exactly as it
 * does for the web dashboard.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { AuthUserLike } from "@/lib/mcp/liatrio-email"

const STORAGE_KEY = "ai-cost-mcp"

export interface McpSupabaseSession {
  access_token: string
  refresh_token: string
  /** Unix seconds. */
  expires_at: number
  user: AuthUserLike & { id: string }
}

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) throw new Error("Supabase is not configured")
  return { url, anon }
}

function memoryClient(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  const storage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  }
  const { url, anon } = env()
  const client = createClient(url, anon, {
    auth: {
      flowType: "pkce",
      storage,
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
  return { client, items }
}

function toSession(s: { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number; user: unknown } | null): McpSupabaseSession {
  if (!s?.access_token || !s.refresh_token || !s.user) throw new Error("Supabase returned no session")
  const expires_at = s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600)
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at, user: s.user as McpSupabaseSession["user"] }
}

/** Start Google sign-in. Returns Supabase's authorize URL and the PKCE state to keep until the callback. */
export async function startGoogleSignIn(redirectTo: string): Promise<{ url: string; pkce: Record<string, string> }> {
  const { client, items } = memoryClient()
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      // A hint for Google's account chooser only; the server checks the email after sign-in.
      queryParams: { hd: "liatrio.com", prompt: "select_account" },
    },
  })
  if (error || !data?.url) throw new Error(error?.message || "Could not start Google sign-in")
  return { url: data.url, pkce: Object.fromEntries(items) }
}

/** Finish Google sign-in: trade Supabase's code (plus the kept PKCE state) for a new session. */
export async function exchangeGoogleCode(code: string, pkce: Record<string, string>): Promise<McpSupabaseSession> {
  const { client } = memoryClient(pkce)
  const { data, error } = await client.auth.exchangeCodeForSession(code)
  if (error) throw new Error(error.message)
  return toSession(data.session)
}

/** Rotate a Supabase refresh token. Supabase refuses a token that was already used. */
export async function refreshSupabaseSession(refreshToken: string): Promise<McpSupabaseSession> {
  const { client } = memoryClient()
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken })
  if (error) throw new Error(error.message)
  return toSession(data.session)
}

/** The user behind a Supabase access token, verified by Supabase (so revoked sessions fail). */
export async function getSupabaseUser(accessToken: string): Promise<McpSupabaseSession["user"] | null> {
  const { client } = memoryClient()
  const { data, error } = await client.auth.getUser(accessToken)
  if (error || !data?.user) return null
  return data.user as McpSupabaseSession["user"]
}

/** Revoke just this session (a refused, non-liatrio sign-in). Best-effort. */
export async function revokeSupabaseSession(session: McpSupabaseSession): Promise<void> {
  try {
    const { client } = memoryClient()
    await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
    await client.auth.signOut({ scope: "local" })
  } catch {
    // The session expires on its own; nothing else to do.
  }
}

/** A Supabase client that reads as the caller (anon key + their access token), so RLS applies. */
export function dataClient(accessToken: string): SupabaseClient {
  const { url, anon } = env()
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}
