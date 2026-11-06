/**
 * Issue #94: the MCP OAuth 2.1 authorization server (authorization code +
 * PKCE S256, refresh tokens, dynamic client registration), adapted from
 * Pulse's /api/oauth/* to this app's Supabase Google sign-in.
 *
 *   MCP client --GET /api/oauth/authorize--> (validate client, redirect_uri, PKCE)
 *     --> Supabase Google sign-in (hd=liatrio.com hint)
 *     --> GET /api/oauth/callback: exchange Supabase's code for a fresh Supabase
 *         session, then require a Google identity at exactly someone@liatrio.com
 *     --> redirect_uri?code=...&state=...
 *   MCP client --POST /api/oauth/token--> access_token + refresh_token
 *
 * Codes and tokens are sealed blobs (lib/mcp/oauth-crypto.ts) carrying the
 * caller's own Supabase session, so no OAuth tables are needed. A code is
 * single-use in effect: redeeming it rotates the Supabase refresh token
 * inside it, and Supabase refuses a rotated token. Every step re-checks the
 * @liatrio.com Google identity and fails closed.
 *
 * Handlers take a Request and return a Response so the App Router routes are
 * one-liners and tests can call them directly.
 */

import { liatrioGoogleEmail } from "@/lib/mcp/liatrio-email"
import {
  isOAuthConfigured,
  nowSeconds,
  open,
  seal,
  verifyPkceS256,
} from "@/lib/mcp/oauth-crypto"
import {
  ACCESS_TOKEN_MAX_TTL,
  AUTH_REQUEST_TTL,
  CODE_TTL,
  MCP_SCOPE,
  OAUTH_PATHS,
  REFRESH_TOKEN_TTL,
  jsonResponse,
  oauthError,
  publicOrigin,
  resourceUrl,
} from "@/lib/mcp/oauth-config"
import { ClientRegistrationError, lookupClient, redirectUriMatches, registerClient } from "@/lib/mcp/oauth-clients"
import {
  exchangeGoogleCode,
  refreshSupabaseSession,
  revokeSupabaseSession,
  startGoogleSignIn,
  type McpSupabaseSession,
} from "@/lib/mcp/supabase-auth"

export const AUTH_REQUEST_COOKIE = "ai_cost_mcp_oauth"

const NOT_CONFIGURED = "MCP sign-in is not configured on this deployment (MCP_OAUTH_SECRET)."

interface AuthRequest extends Record<string, unknown> {
  client_id: string
  redirect_uri: string
  state: string | null
  code_challenge: string
  resource: string
  scope: string
  pkce: Record<string, string>
  exp: number
}

interface CodePayload extends Record<string, unknown> {
  client_id: string
  redirect_uri: string
  code_challenge: string
  resource: string
  scope: string
  srt: string
  sub: string
  email: string
  exp: number
}

export interface AccessPayload extends Record<string, unknown> {
  sat: string
  sub: string
  email: string
  aud: string
  client_id: string
  scope: string
  exp: number
}

interface RefreshPayload extends Record<string, unknown> {
  srt: string
  sub: string
  email: string
  aud: string
  client_id: string
  scope: string
  exp: number
}

function htmlError(title: string, message: string, status = 400): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(message)}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  )
}

function redirectWith(redirectUri: string, params: Record<string, string | null | undefined>, extraHeaders: Headers = new Headers()): Response {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v)
  extraHeaders.set("Location", u.toString())
  extraHeaders.set("Cache-Control", "no-store")
  return new Response(null, { status: 302, headers: extraHeaders })
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/api/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? ""
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === name) return rest.join("=")
  }
  return null
}

/** The resource the client asked for must be this MCP server (RFC 8707); absent means this server. */
function resolveResource(requested: string | null, origin: string): string | null {
  const ours = resourceUrl(origin)
  if (!requested) return ours
  return requested.replace(/\/+$/, "") === ours ? ours : null
}

/** GET /api/oauth/authorize */
export async function handleAuthorize(request: Request): Promise<Response> {
  if (!isOAuthConfigured()) return htmlError("Sign-in unavailable", NOT_CONFIGURED, 503)
  const origin = publicOrigin(request)
  const sp = new URL(request.url).searchParams

  const client = lookupClient(sp.get("client_id"))
  if (!client) return htmlError("Unknown client", "This MCP client is not registered. Remove the server from your MCP client and add it again.")
  const redirectUri = sp.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null)
  if (!redirectUriMatches(client, redirectUri)) return htmlError("Invalid redirect", "redirect_uri does not match the client registration.")

  // From here on, errors go back to the client's (validated) redirect_uri.
  const state = sp.get("state")
  const fail = (error: string, description: string) => redirectWith(redirectUri, { error, error_description: description, state })
  if (sp.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code")
  const challenge = sp.get("code_challenge")
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || sp.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required")
  }
  const resource = resolveResource(sp.get("resource"), origin)
  if (!resource) return fail("invalid_target", "resource must be this server's MCP endpoint")
  const requestedScopes = (sp.get("scope") ?? MCP_SCOPE).split(/\s+/).filter(Boolean)
  if (requestedScopes.some((s) => s !== MCP_SCOPE)) return fail("invalid_scope", `only ${MCP_SCOPE} is supported`)

  let google: { url: string; pkce: Record<string, string> }
  try {
    google = await startGoogleSignIn(`${origin}${OAUTH_PATHS.callback}`)
  } catch (e) {
    console.error("MCP authorize: Google sign-in could not start:", e instanceof Error ? e.message : e)
    return fail("server_error", "Google sign-in could not start")
  }
  const req: AuthRequest = {
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    resource,
    scope: MCP_SCOPE,
    pkce: google.pkce,
    exp: nowSeconds() + AUTH_REQUEST_TTL,
  }
  const headers = new Headers({ Location: google.url, "Cache-Control": "no-store" })
  headers.append("Set-Cookie", cookie(AUTH_REQUEST_COOKIE, seal("authreq", req), AUTH_REQUEST_TTL, origin.startsWith("https:")))
  return new Response(null, { status: 302, headers })
}

/** GET /api/oauth/callback (Supabase redirects here after Google). */
export async function handleCallback(request: Request): Promise<Response> {
  if (!isOAuthConfigured()) return htmlError("Sign-in unavailable", NOT_CONFIGURED, 503)
  const origin = publicOrigin(request)
  const secure = origin.startsWith("https:")
  const req = open<AuthRequest>("authreq", readCookie(request, AUTH_REQUEST_COOKIE))
  if (!req) return htmlError("Sign-in expired", "This sign-in link expired or was opened in another browser. Start the connection again from your MCP client.")
  const client = lookupClient(req.client_id)
  if (!client || !redirectUriMatches(client, req.redirect_uri)) return htmlError("Unknown client", "This MCP client is no longer registered.")

  const clear = new Headers()
  clear.append("Set-Cookie", cookie(AUTH_REQUEST_COOKIE, "", 0, secure))
  const fail = (error: string, description: string) =>
    redirectWith(req.redirect_uri, { error, error_description: description, state: req.state }, clear)

  const sp = new URL(request.url).searchParams
  const code = sp.get("code")
  if (!code) return fail("access_denied", sp.get("error_description") || "Google sign-in was cancelled")

  let session: McpSupabaseSession
  try {
    session = await exchangeGoogleCode(code, req.pkce)
  } catch (e) {
    console.error("MCP callback: code exchange failed:", e instanceof Error ? e.message : e)
    return fail("access_denied", "Google sign-in failed")
  }
  const email = liatrioGoogleEmail(session.user)
  if (!email) {
    await revokeSupabaseSession(session)
    return fail("access_denied", "Only @liatrio.com Google accounts can connect to the AI Cost Dashboard")
  }
  const payload: CodePayload = {
    client_id: client.client_id,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    resource: req.resource,
    scope: req.scope,
    srt: session.refresh_token,
    sub: session.user.id,
    email,
    exp: nowSeconds() + CODE_TTL,
  }
  return redirectWith(req.redirect_uri, { code: seal("code", payload), state: req.state, iss: origin }, clear)
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? ""
  try {
    if (type.includes("application/json")) {
      const body = await request.json()
      return Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>
    }
    return Object.fromEntries(new URLSearchParams(await request.text()))
  } catch {
    return {}
  }
}

function issueTokens(session: McpSupabaseSession, base: { email: string; aud: string; client_id: string; scope: string }): Response {
  const now = nowSeconds()
  const accessExp = Math.min(session.expires_at, now + ACCESS_TOKEN_MAX_TTL)
  const access: AccessPayload = { ...base, sat: session.access_token, sub: session.user.id, exp: accessExp }
  const refresh: RefreshPayload = { ...base, srt: session.refresh_token, sub: session.user.id, exp: now + REFRESH_TOKEN_TTL }
  return jsonResponse({
    access_token: seal("access", access),
    token_type: "Bearer",
    expires_in: Math.max(accessExp - now, 0),
    refresh_token: seal("refresh", refresh),
    scope: base.scope,
  })
}

/** Rotate the Supabase session and re-check the Google @liatrio.com identity. */
async function rotate(srt: string): Promise<{ session: McpSupabaseSession; email: string } | null> {
  let session: McpSupabaseSession
  try {
    session = await refreshSupabaseSession(srt)
  } catch {
    return null
  }
  const email = liatrioGoogleEmail(session.user)
  if (!email) {
    await revokeSupabaseSession(session)
    return null
  }
  return { session, email }
}

/** POST /api/oauth/token */
export async function handleToken(request: Request): Promise<Response> {
  if (!isOAuthConfigured()) return oauthError("temporarily_unavailable", NOT_CONFIGURED, 503)
  const form = await readForm(request)
  const client = lookupClient(form.client_id)
  if (!client) return oauthError("invalid_client", "Unknown client_id", 401)

  if (form.grant_type === "authorization_code") {
    const code = open<CodePayload>("code", form.code)
    if (!code || code.client_id !== client.client_id) return oauthError("invalid_grant", "Invalid or expired authorization code")
    if (form.redirect_uri && form.redirect_uri !== code.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match")
    if (!verifyPkceS256(form.code_verifier, code.code_challenge)) return oauthError("invalid_grant", "PKCE verification failed")
    if (form.resource && form.resource.replace(/\/+$/, "") !== code.resource) return oauthError("invalid_target", "resource does not match")
    const rotated = await rotate(code.srt)
    if (!rotated || rotated.session.user.id !== code.sub) return oauthError("invalid_grant", "Authorization code already used or sign-in revoked")
    return issueTokens(rotated.session, { email: rotated.email, aud: code.resource, client_id: client.client_id, scope: code.scope })
  }

  if (form.grant_type === "refresh_token") {
    const rt = open<RefreshPayload>("refresh", form.refresh_token)
    if (!rt || rt.client_id !== client.client_id) return oauthError("invalid_grant", "Invalid or expired refresh token")
    const rotated = await rotate(rt.srt)
    if (!rotated || rotated.session.user.id !== rt.sub) return oauthError("invalid_grant", "Refresh token already used or sign-in revoked")
    return issueTokens(rotated.session, { email: rotated.email, aud: rt.aud, client_id: client.client_id, scope: rt.scope })
  }

  return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
}

/** POST /api/oauth/register (RFC 7591). */
export async function handleRegister(request: Request): Promise<Response> {
  if (!isOAuthConfigured()) return oauthError("temporarily_unavailable", NOT_CONFIGURED, 503)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON")
  }
  try {
    const client = registerClient(body)
    return jsonResponse(
      {
        client_id: client.client_id,
        client_id_issued_at: client.iat,
        client_name: client.client_name ?? undefined,
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: MCP_SCOPE,
      },
      201
    )
  } catch (e) {
    if (e instanceof ClientRegistrationError) return oauthError(e.code, e.message)
    throw e
  }
}
