/**
 * DELETE /api/admin/org/identities/:id — remove an identity mapping.
 */

import { NextResponse, type NextRequest } from "next/server"
import { notFound, withAdmin } from "@/lib/org/admin-server"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  return withAdmin("Failed to delete identity", async ({ admin }) => {
    const { id } = await params
    const { data, error } = await admin.from("person_identities").delete().eq("id", id).select("id")
    if (error) throw error
    if (!data?.length) notFound("Identity")
    await refreshDailyAggregates()
    return NextResponse.json({ deleted: id })
  })
}
