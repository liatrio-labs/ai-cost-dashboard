/**
 * Issue #94: OAuth clients (Cursor, Claude, Claude Code, MCP Inspector, ...)
 * register themselves with RFC 7591 dynamic client registration. Pulse keeps
 * its clients in lib/oauth-clients.ts; here the client id is a sealed record
 * of the registration (redirect URIs, name), so no table is needed and a
 * client id can't be forged or edited. Public clients only (PKCE, no secret).
 */

import { open, seal } from "@/lib/mcp/oauth-crypto"

export interface OAuthClient {
  client_id: string
  client_name: string | null
  redirect_uris: string[]
  iat: number
}

export class ClientRegistrationError extends Error {
  constructor(public readonly code: "invalid_redirect_uri" | "invalid_client_metadata", message: string) {
    super(message)
  }
}

const MAX_REDIRECT_URIS = 10
const MAX_URI_LENGTH = 2000
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"])
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

function isLoopback(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)
}

/**
 * Allowed: https URLs, http loopback (native apps, RFC 8252), and private-use
 * schemes such as cursor://. No fragments, no credentials, no script-capable
 * or non-loopback http schemes.
 */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || !uri || uri.length > MAX_URI_LENGTH) return false
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.hash || u.username || u.password) return false
  if (BLOCKED_SCHEMES.has(u.protocol)) return false
  if (u.protocol === "https:") return !!u.hostname
  if (u.protocol === "http:") return isLoopback(u)
  // Private-use scheme (RFC 8252 7.1), e.g. cursor://anysphere.cursor-mcp/oauth/callback.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol)
}

export function registerClient(body: unknown, now: number = Date.now()): OAuthClient {
  const meta = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const uris = meta.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new ClientRegistrationError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`)
  }
  for (const uri of uris) {
    if (!isAllowedRedirectUri(uri)) throw new ClientRegistrationError("invalid_redirect_uri", `redirect_uri not allowed: ${String(uri).slice(0, 200)}`)
  }
  const grants = meta.grant_types
  if (grants !== undefined && (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token"))) {
    throw new ClientRegistrationError("invalid_client_metadata", "only authorization_code and refresh_token grants are supported")
  }
  const name = typeof meta.client_name === "string" ? meta.client_name.trim().slice(0, 200) || null : null
  const iat = Math.floor(now / 1000)
  const redirect_uris = [...new Set(uris as string[])]
  return { client_id: seal("client", { redirect_uris, client_name: name, iat }), client_name: name, redirect_uris, iat }
}

/** The registered client, or null for an unknown / forged / malformed client id. */
export function lookupClient(clientId: unknown): OAuthClient | null {
  const p = open<{ redirect_uris?: unknown; client_name?: unknown; iat?: unknown }>("client", clientId)
  if (!p || !Array.isArray(p.redirect_uris) || !p.redirect_uris.every(isAllowedRedirectUri)) return null
  return {
    client_id: clientId as string,
    client_name: typeof p.client_name === "string" ? p.client_name : null,
    redirect_uris: p.redirect_uris as string[],
    iat: typeof p.iat === "number" ? p.iat : 0,
  }
}

/**
 * Exact match, except a loopback redirect may use any port (RFC 8252 7.3:
 * native apps pick a free port at runtime).
 */
export function redirectUriMatches(client: OAuthClient, uri: unknown): uri is string {
  if (typeof uri !== "string") return false
  if (client.redirect_uris.includes(uri)) return true
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (!isLoopback(u) || u.hash) return false
  return client.redirect_uris.some((r) => {
    try {
      const reg = new URL(r)
      return isLoopback(reg) && reg.hostname === u.hostname && reg.pathname === u.pathname && reg.search === u.search
    } catch {
      return false
    }
  })
}
