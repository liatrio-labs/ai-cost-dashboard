/** MCP OAuth (issue #94): see lib/mcp/oauth-flow.ts. */

import { handleToken } from "@/lib/mcp/oauth-flow"
import { corsPreflight } from "@/lib/mcp/oauth-config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = handleToken
export const OPTIONS = corsPreflight
