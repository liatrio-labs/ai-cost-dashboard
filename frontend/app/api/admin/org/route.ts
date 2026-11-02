/**
 * GET /api/admin/org — the whole org (departments, teams, people, identities,
 * registered API keys) plus providers, for the admin org screens (#7).
 */

import { NextResponse } from "next/server"
import { loadOrgData, withAdmin } from "@/lib/org/admin-server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return withAdmin("Failed to load org", async ({ admin }) => {
    const [org, providers] = await Promise.all([
      loadOrgData(admin),
      admin.from("providers").select("id, name, display_name").order("display_name"),
    ])
    if (providers.error) throw providers.error
    return NextResponse.json({ ...org, providers: providers.data ?? [] })
  })
}
