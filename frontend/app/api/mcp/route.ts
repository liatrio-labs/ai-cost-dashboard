/**
 * Remote MCP server (issue #94): https://ai-cost.liatr.io/api/mcp
 * Read-only dashboard spend tools; OAuth sign-in with Google, @liatrio.com
 * only. See docs/mcp.md and lib/mcp/.
 */

import { handleMcpOther, handleMcpPost } from "@/lib/mcp/http"
import { corsPreflight } from "@/lib/mcp/oauth-config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = handleMcpPost
export const GET = handleMcpOther
export const DELETE = handleMcpOther
export const OPTIONS = corsPreflight
