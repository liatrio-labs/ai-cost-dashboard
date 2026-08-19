/**
 * Vercel Cron endpoint for Claude.ai (Enterprise Analytics API) collection.
 *
 * Collects org-wide cost/usage (last 31 UTC days, so late revisions match
 * the Claude.ai Usage admin page). Scheduled daily in vercel.json.
 */

import { NextRequest } from "next/server"
import { triggerProviderCollection } from "@/lib/collection"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: NextRequest) {
  return triggerProviderCollection(request, "claude-ai")
}
