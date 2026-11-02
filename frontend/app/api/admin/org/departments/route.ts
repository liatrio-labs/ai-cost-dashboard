/**
 * POST /api/admin/org/departments — create { name, description? }.
 */

import { NextResponse } from "next/server"
import { loadOrgData, readJson, withAdmin } from "@/lib/org/admin-server"
import { orgSchemas } from "@/lib/org/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return withAdmin("Failed to create department", async ({ admin }) => {
    const input = orgSchemas(await loadOrgData(admin)).departmentCreate.parse(await readJson(request))
    const { data, error } = await admin
      .from("departments")
      .insert({ name: input.name, description: input.description ?? null })
      .select()
      .single()
    if (error) throw error
    return NextResponse.json(data, { status: 201 })
  })
}
