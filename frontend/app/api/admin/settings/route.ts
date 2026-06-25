/**
 * Owner-only app settings.
 *
 * GET  /api/admin/settings  — current forecast settings + implied plateau
 * PUT  /api/admin/settings  — { employees } updates the forecast headcount
 *
 * The forecast plateau scales with employee count (see lib/forecast-settings).
 */

import { NextRequest } from "next/server"
import { cookies } from "next/headers"
import { requireAdmin, errorResponse, successResponse } from "@/lib/db"
import {
  getForecastSettings,
  setForecastEmployees,
  plateauForEmployees,
} from "@/lib/forecast-settings"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)
    const forecast = await getForecastSettings()
    return successResponse({ forecast, plateau: plateauForEmployees(forecast) })
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    return errorResponse(e?.message || "Failed to load settings", 500)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    await requireAdmin(cookieStore)

    const body = await request.json().catch(() => ({}))
    const employees = Number(body.employees)
    if (!Number.isFinite(employees) || employees < 0) {
      return errorResponse("employees must be a non-negative number", 400)
    }

    const forecast = await setForecastEmployees(employees)
    return successResponse({
      message: "Forecast settings updated",
      forecast,
      plateau: plateauForEmployees(forecast),
    })
  } catch (e: any) {
    if (e?.message === "Unauthorized") return errorResponse("Unauthorized", 401)
    if (e?.message === "Forbidden") return errorResponse("Forbidden", 403)
    return errorResponse(e?.message || "Failed to update settings", 500)
  }
}
