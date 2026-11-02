/**
 * Import people from observed data: distinct metadata.attribution.person_email
 * values in cost_records.
 *
 * GET  /api/admin/org/people/import[?days=N]  — dry-run preview
 * POST /api/admin/org/people/import           — { confirm?, emails?, team_id?, days? }
 *      Without confirm: true it is the same dry run and creates nothing.
 *      With confirm: true it creates people for the observed emails that have
 *      no person yet (or just `emails`, if given), named from person_name.
 *
 * `days` is the lookback window (default 365).
 */

import { NextResponse, type NextRequest } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { daysAgo, HttpError, loadCostRecords, loadOrgData, readJson, withAdmin } from "@/lib/org/admin-server"
import { observedPeople } from "@/lib/org/observed"
import { importPeopleSchema, lookbackDaysSchema } from "@/lib/org/schemas"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DEFAULT_DAYS = 365

async function preview(admin: SupabaseClient, days: number) {
  const [org, records] = await Promise.all([
    loadOrgData(admin),
    loadCostRecords(admin, { start: daysAgo(days), jsonPathNotNull: "metadata->attribution->>person_email" }),
  ])
  const candidates = observedPeople(records, org)
  return { org, candidates, toCreate: candidates.filter((c) => !c.existing_person_id) }
}

export async function GET(request: NextRequest) {
  return withAdmin("Failed to preview import", async ({ admin }) => {
    const days = lookbackDaysSchema.parse(request.nextUrl.searchParams.get("days") ?? DEFAULT_DAYS)
    const { candidates, toCreate } = await preview(admin, days)
    return NextResponse.json({ dry_run: true, days, candidates, to_create: toCreate.length, created: [] })
  })
}

export async function POST(request: Request) {
  return withAdmin("Failed to import people", async ({ admin }) => {
    const input = importPeopleSchema.parse(await readJson(request))
    const days = input.days ?? DEFAULT_DAYS
    const { org, candidates, toCreate } = await preview(admin, days)

    if (!input.confirm) {
      return NextResponse.json({ dry_run: true, days, candidates, to_create: toCreate.length, created: [] })
    }

    const teamId = input.team_id ?? null
    if (teamId && !org.teams.some((t) => t.id === teamId)) throw new HttpError(400, "Unknown team id")

    const wanted = input.emails ? new Set(input.emails) : null
    const rows = toCreate
      .filter((c) => !wanted || wanted.has(c.email))
      .map((c) => ({ email: c.email, display_name: c.name, team_id: teamId, active: true }))

    if (!rows.length) {
      return NextResponse.json({ dry_run: false, days, candidates, to_create: 0, created: [] })
    }

    const { data, error } = await admin
      .from("people")
      .upsert(rows, { onConflict: "email", ignoreDuplicates: true })
      .select()
    if (error) throw error
    await refreshDailyAggregates()
    return NextResponse.json({ dry_run: false, days, candidates, to_create: rows.length, created: data ?? [] }, { status: 201 })
  })
}
