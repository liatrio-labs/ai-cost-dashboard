/**
 * Issue #94: a minimal, stateless MCP server over Streamable HTTP. Each POST
 * carries one JSON-RPC message (or a batch) and gets a single JSON response;
 * there are no sessions and no server-initiated messages, so no SSE stream.
 * Methods: initialize, ping, tools/list, tools/call, and notifications (202).
 *
 * Authentication happens before this (lib/mcp/auth.ts); this module only
 * dispatches to the read-only tools in lib/mcp/tools.ts.
 */

import { MCP_TOOLS, ToolInputError, type McpTool, type ToolContext } from "@/lib/mcp/tools"

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]
export const SERVER_INFO = { name: "ai-cost-dashboard", title: "Liatrio AI Cost Dashboard", version: "1.0.0" }

const INSTRUCTIONS =
  "Read-only access to the Liatrio AI Cost Dashboard's spend data, computed with the same logic as https://ai-cost.liatr.io. " +
  "Periods are calendar months (YYYY-MM) or start/end dates. Filter by department, team, person (id, email or name), API key or provider; list_org_directory lists ids. " +
  "Fixed / subscription is seats and licenses; Variable / usage is metered on-demand only (Cursor included usage is not extra cost). " +
  "Cursor billing-cycle on-demand (get_cursor_billing_cycle) is a separate measure: never add it to calendar-month totals or seat fees."

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } }

const err = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } })

function isRequest(m: unknown): m is JsonRpcRequest {
  return !!m && typeof m === "object" && (m as JsonRpcRequest).jsonrpc === "2.0" && typeof (m as JsonRpcRequest).method === "string"
}

export function toolDescriptor(t: McpTool) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }
}

async function callTool(params: Record<string, unknown> | undefined, ctx: ToolContext) {
  const name = params?.name
  const tool = MCP_TOOLS.find((t) => t.name === name)
  if (!tool) return null
  const args = params?.arguments ?? {}
  if (typeof args !== "object" || Array.isArray(args)) {
    return { content: [{ type: "text", text: "arguments must be an object" }], isError: true }
  }
  const allowed = new Set(Object.keys((tool.inputSchema.properties as Record<string, unknown>) ?? {}))
  const unknown = Object.keys(args).filter((k) => !allowed.has(k))
  if (unknown.length) return { content: [{ type: "text", text: `Unknown argument(s): ${unknown.join(", ")}` }], isError: true }
  try {
    const result = await tool.handler(args as Record<string, unknown>, ctx)
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }
  } catch (e) {
    const message = e instanceof ToolInputError ? e.message : "The dashboard data could not be loaded"
    if (!(e instanceof ToolInputError)) console.error(`MCP tool ${tool.name} failed:`, e instanceof Error ? e.message : e)
    return { content: [{ type: "text", text: message }], isError: true }
  }
}

/** One JSON-RPC message. Returns null for notifications (no response). */
export async function handleMessage(message: unknown, ctx: ToolContext): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) return err(null, -32600, "Invalid Request")
  const { id, method, params } = message
  if (id === undefined) return null // notification (e.g. notifications/initialized)

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested) ? (requested as string) : LATEST_PROTOCOL_VERSION
      return {
        jsonrpc: "2.0",
        id,
        result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
      }
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS.map(toolDescriptor) } }
    case "tools/call": {
      const result = await callTool(params, ctx)
      if (!result) return err(id, -32602, `Unknown tool: ${String(params?.name)}`)
      return { jsonrpc: "2.0", id, result }
    }
    default:
      return err(id, -32601, `Method not found: ${method}`)
  }
}

/** A POST body: one message or a batch. Returns null when nothing needs a response (202). */
export async function handlePayload(payload: unknown, ctx: ToolContext): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (!payload.length) return err(null, -32600, "Invalid Request")
    const out = (await Promise.all(payload.map((m) => handleMessage(m, ctx)))).filter((r): r is JsonRpcResponse => r !== null)
    return out.length ? out : null
  }
  return handleMessage(payload, ctx)
}
