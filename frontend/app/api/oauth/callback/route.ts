/** MCP OAuth (issue #94): see lib/mcp/oauth-flow.ts. */

import { handleCallback } from "@/lib/mcp/oauth-flow"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handleCallback
