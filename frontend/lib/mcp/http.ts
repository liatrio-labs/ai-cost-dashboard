/**
 * Issue #94: the /api/mcp request handler (Streamable HTTP, JSON responses).
 * Authenticates first (fails closed with a WWW-Authenticate challenge), then
 * dispatches JSON-RPC to the read-only tools with the caller's RLS-scoped
 * Supabase client.
 */

import { authenticateMcpRequest } from "@/lib/mcp/auth"
import { jsonResponse, CORS_HEADERS } from "@/lib/mcp/oauth-config"
import { handlePayload } from "@/lib/mcp/server"
import { dataClient } from "@/lib/mcp/supabase-auth"
import type { SupabaseLike } from "@/lib/dashboard-data"

const MAX_BODY_BYTES = 256 * 1024

export async function handleMcpPost(request: Request): Promise<Response> {
  const auth = await authenticateMcpRequest(request)
  if (!auth.ok) return auth.response

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400)
  }

  const supabase = dataClient(auth.caller.supabaseAccessToken) as unknown as SupabaseLike
  const result = await handlePayload(payload, { supabase, caller: { email: auth.caller.email, userId: auth.caller.userId } })
  if (result === null) return new Response(null, { status: 202, headers: CORS_HEADERS })
  return jsonResponse(result)
}

/** GET (SSE stream) and DELETE (session end) are not offered: the server is stateless. */
export async function handleMcpOther(request: Request): Promise<Response> {
  const auth = await authenticateMcpRequest(request)
  if (!auth.ok) return auth.response
  return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } })
}
