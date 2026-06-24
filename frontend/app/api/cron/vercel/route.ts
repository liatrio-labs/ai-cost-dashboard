/**
 * Vercel Cron endpoint for Vercel (usage/billing API) collection.
 *
 * Calls the Python backend to collect usage/cost for every active vercel
 * credential. Scheduled daily in vercel.json.
 */

import { NextRequest } from "next/server"
import { triggerProviderCollection } from "@/lib/collection"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: NextRequest) {
  return triggerProviderCollection(request, "vercel")
}
