/** RFC 8414 authorization server metadata for the MCP server (issue #94). */

import { authorizationServerMetadata, corsPreflight, jsonResponse, publicOrigin } from "@/lib/mcp/oauth-config"

export const dynamic = "force-dynamic"

export function GET(request: Request) {
  return jsonResponse(authorizationServerMetadata(publicOrigin(request)))
}
export const OPTIONS = corsPreflight
