/**
 * POST /api/admin/org/teams — create { name, department_id? }.
 * Team names are unique within a department.
 */

import { NextResponse } from "next/server"
import { loadOrgData, readJson, withAdmin } from "@/lib/org/admin-server"
import { orgSchemas } from "@/lib/org/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return withAdmin("Failed to create team", async ({ admin }) => {
    const input = orgSchemas(await loadOrgData(admin)).teamCreate.parse(await readJson(request))
    const { data, error } = await admin
      .from("teams")
      .insert({ name: input.name, department_id: input.department_id })
      .select()
      .single()
    if (error) throw error
    return NextResponse.json(data, { status: 201 })
  })
}
