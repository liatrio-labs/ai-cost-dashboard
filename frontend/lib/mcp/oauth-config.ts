/**
 * Issue #94: the MCP server's public URLs and its OAuth metadata documents
 * (RFC 8414 authorization server metadata, RFC 9728 protected resource
 * metadata), modeled on Pulse's lib/oauth-metadata.ts.
 *
 * The public origin comes from MCP_PUBLIC_URL when set (production:
 * https://ai-cost.liatr.io), else the request's forwarded host / URL. Tokens
 * are bound to the resource URL, so set MCP_PUBLIC_URL wherever the app runs
 * behind a proxy.
 */

export const MCP_PATH = "/api/mcp"
export const MCP_SCOPE = "ai-cost:read"
export const OAUTH_PATHS = {
  authorize: "/api/oauth/authorize",
  callback: "/api/oauth/callback",
  token: "/api/oauth/token",
  register: "/api/oauth/register",
} as const
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource"
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server"

/** Lifetimes (seconds). */
export const AUTH_REQUEST_TTL = 10 * 60
export const CODE_TTL = 5 * 60
export const ACCESS_TOKEN_MAX_TTL = 60 * 60
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60

function trimOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    return u.origin
  } catch {
    return null
  }
}

export function publicOrigin(request: Request): string {
  const configured = process.env.MCP_PUBLIC_URL && trimOrigin(process.env.MCP_PUBLIC_URL)
  if (configured) return configured
  const url = new URL(request.url)
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
  if (host && /^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
    return `${proto === "http" || proto === "https" ? proto : url.protocol.replace(":", "")}://${host}`
  }
  return url.origin
}

export const resourceUrl = (origin: string) => `${origin}${MCP_PATH}`
export const resourceMetadataUrl = (origin: string) => `${origin}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`

export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "AI Cost Dashboard (read-only)",
    resource_documentation: "https://github.com/liatrio-labs/ai-cost-dashboard/blob/main/docs/mcp.md",
  }
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${origin}${OAUTH_PATHS.token}`,
    registration_endpoint: `${origin}${OAUTH_PATHS.register}`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://github.com/liatrio-labs/ai-cost-dashboard/blob/main/docs/mcp.md",
  }
}

/** CORS for the bearer-token endpoints (no cookies are read, so any origin is safe). */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS, ...headers },
  })
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export function oauthError(error: string, description: string, status = 400, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error, error_description: description }, status, headers)
}
