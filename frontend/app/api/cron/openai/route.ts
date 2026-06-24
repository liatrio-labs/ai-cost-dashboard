/**
 * Vercel Cron endpoint for OpenAI data collection.
 *
 * Calls the Python backend to collect cost/usage data for every active
 * OpenAI credential. Scheduled daily in vercel.json.
 */

import { NextRequest } from "next/server"
import { triggerProviderCollection } from "@/lib/collection"

// Node runtime: this route makes an authenticated server-to-server fetch and
// reads server-only secrets, which the edge runtime is not suited for.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 minutes max

export async function GET(request: NextRequest) {
  return triggerProviderCollection(request, "openai")
}
