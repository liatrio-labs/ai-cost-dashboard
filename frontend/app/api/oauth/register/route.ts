/** MCP OAuth (issue #94): see lib/mcp/oauth-flow.ts. */

import { handleRegister } from "@/lib/mcp/oauth-flow"
import { corsPreflight } from "@/lib/mcp/oauth-config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = handleRegister
export const OPTIONS = corsPreflight
