/**
 * Vercel Cron endpoint for Windsurf (CascadeAnalytics) collection.
 *
 * Runs collection in-process via the TypeScript collectors. Scheduled daily in
 * vercel.json. Optional manual backfill via ?backfill=true&days=180.
 */

import { NextRequest } from "next/server"
import { triggerProviderCollection } from "@/lib/collection"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: NextRequest) {
  return triggerProviderCollection(request, "windsurf")
}
