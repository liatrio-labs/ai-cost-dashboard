/**
 * Issue #94: bearer authentication for /api/mcp. Fails closed: no token, a
 * token that doesn't open (forged, expired, wrong type), a token for another
 * resource, a Supabase session Supabase no longer accepts, or a user who is
 * not a Google @liatrio.com account all get 401 with a WWW-Authenticate
 * challenge pointing at the protected resource metadata (as Pulse does).
 */

import { liatrioGoogleEmail } from "@/lib/mcp/liatrio-email"
import { isOAuthConfigured, open } from "@/lib/mcp/oauth-crypto"
import { MCP_SCOPE, jsonResponse, publicOrigin, resourceMetadataUrl, resourceUrl } from "@/lib/mcp/oauth-config"
import type { AccessPayload } from "@/lib/mcp/oauth-flow"
import { getSupabaseUser } from "@/lib/mcp/supabase-auth"

export interface McpCaller {
  userId: string
  email: string
  /** The caller's own Supabase access token, for RLS-scoped reads. Never returned to tools' output. */
  supabaseAccessToken: string
}

export type McpAuthResult = { ok: true; caller: McpCaller } | { ok: false; response: Response }

export function unauthorized(request: Request, error?: "invalid_token", description?: string): Response {
  const origin = publicOrigin(request)
  const parts = [`resource_metadata="${resourceMetadataUrl(origin)}"`, `scope="${MCP_SCOPE}"`]
  if (error) parts.push(`error="${error}"`, `error_description="${(description ?? "").replace(/"/g, "'")}"`)
  return jsonResponse(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message: description || "Authentication required: sign in with your @liatrio.com Google account" } },
    401,
    { "WWW-Authenticate": `Bearer ${parts.join(", ")}` }
  )
}

export async function authenticateMcpRequest(request: Request): Promise<McpAuthResult> {
  const header = request.headers.get("authorization") ?? ""
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!m) return { ok: false, response: unauthorized(request) }
  if (!isOAuthConfigured()) return { ok: false, response: unauthorized(request, "invalid_token", "MCP sign-in is not configured on this deployment") }

  const token = open<AccessPayload>("access", m[1])
  if (!token || typeof token.sat !== "string") return { ok: false, response: unauthorized(request, "invalid_token", "Invalid or expired access token") }
  if (token.aud !== resourceUrl(publicOrigin(request))) {
    return { ok: false, response: unauthorized(request, "invalid_token", "Token was issued for a different resource") }
  }

  const user = await getSupabaseUser(token.sat)
  const email = liatrioGoogleEmail(user)
  if (!user || !email || user.id !== token.sub || email !== token.email) {
    return { ok: false, response: unauthorized(request, "invalid_token", "Sign-in expired or not a @liatrio.com Google account") }
  }
  return { ok: true, caller: { userId: user.id, email, supabaseAccessToken: token.sat } }
}
