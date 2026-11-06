/** RFC 9728 protected resource metadata for /api/mcp (issue #94). */

import { corsPreflight, jsonResponse, protectedResourceMetadata, publicOrigin } from "@/lib/mcp/oauth-config"

export const dynamic = "force-dynamic"

export function GET(request: Request) {
  return jsonResponse(protectedResourceMetadata(publicOrigin(request)))
}
export const OPTIONS = corsPreflight
