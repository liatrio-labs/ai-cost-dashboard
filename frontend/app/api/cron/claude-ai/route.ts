/**
 * Vercel Cron endpoint for Claude.ai (Enterprise Analytics API) collection.
 *
 * Calls the Python backend to collect per-user cost/usage for every active
 * claude-ai credential. Scheduled daily in vercel.json.
 */

import { NextRequest } from "next/server"
import { triggerProviderCollection } from "@/lib/collection"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: NextRequest) {
  return triggerProviderCollection(request, "claude-ai")
}
