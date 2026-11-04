/**
 * Team / department forecast overrides (issue #9). Admin only.
 *
 * GET /api/admin/forecast-units
 *   -> { orgPlateau, employees, trailingMonths, department: Unit[], team: Unit[] }
 *   Each unit: its trailing share, allocated plateau, effective plateau,
 *   override (if any) and next projected month. Like the dashboard, the
 *   projection is anchored on the projected current month (issue #39).
 *
 * PUT /api/admin/forecast-units
 *   { level: "team" | "department", key: <id | "unassigned">,
 *     plateauUsd?: number | null, headcount?: number | null }
 *   Sets one unit's override (plateauUsd wins over headcount); both null clears
 *   it. Returns the same payload as GET.
 *
 * Overrides live in app_settings (key 'forecast_units'); see
 * lib/forecast-settings.ts and lib/unit-forecast.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { adminRoute, HttpError, json, must, parseBody } from "@/lib/org/admin/http"
import { fetchAttributedDaily, fetchProviders, fetchRecurringDaily, type SupabaseLike } from "@/lib/dashboard-data"
import {
  getForecastSettings,
  getForecastUnitOverrides,
  setForecastUnitOverride,
  unitOverrideKey,
  UNIT_LEVELS,
  type UnitLevel,
  type UnitOverrides,
} from "@/lib/forecast-settings"
import { computeUnitForecasts } from "@/lib/unit-forecast"
import { projectionContext } from "@/lib/projection"
import { UNASSIGNED_KEY, UNASSIGNED_LABEL } from "@/lib/org/rollup"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const amount = z.number().finite().min(0).max(1e9).nullable().optional()
const putSchema = z.object({
  level: z.enum(UNIT_LEVELS as [UnitLevel, ...UnitLevel[]]),
  key: z.string().trim().min(1).max(200),
  plateauUsd: amount,
  headcount: amount,
})

interface NamedUnit {
  id: string
  name: string
}

async function loadUnits(admin: SupabaseClient): Promise<Record<UnitLevel, NamedUnit[]>> {
  const [departments, teams] = await Promise.all([
    admin.from("departments").select("id, name").order("name"),
    admin.from("teams").select("id, name").order("name"),
  ])
  return {
    department: (must(departments) ?? []) as NamedUnit[],
    team: (must(teams) ?? []) as NamedUnit[],
  }
}

async function payload(admin: SupabaseClient, units: Record<UnitLevel, NamedUnit[]>, overrides: UnitOverrides) {
  const settings = await getForecastSettings()
  const [attributed, providers, recurring] = await Promise.all([
    fetchAttributedDaily(admin as unknown as SupabaseLike, {}, null),
    fetchProviders(admin as unknown as SupabaseLike),
    fetchRecurringDaily(admin as unknown as SupabaseLike, { now: new Date() }), // issue #59
  ])
  const rows = [...attributed, ...recurring]
  // Same anchor as /api/dashboard's unit forecasts: the projected current month.
  const current = projectionContext(providers, new Date())
  const out: Record<string, unknown> = { employees: settings.employees }
  for (const level of UNIT_LEVELS) {
    const names = new Map(units[level].map((u) => [u.id, u.name]))
    const result = computeUnitForecasts({ rows, level, settings, overrides, include: units[level].map((u) => u.id), current })
    out.orgPlateau = result.orgPlateau
    out.trailingMonths = result.trailingMonths
    out[level] = result.units.map((u) => ({
      key: u.key,
      name: u.unassigned ? UNASSIGNED_LABEL : names.get(u.key) ?? u.key,
      unassigned: u.unassigned,
      trailingSpend: u.trailingSpend,
      share: Math.round(u.share * 10000) / 10000,
      allocatedPlateau: u.allocatedPlateau,
      plateau: u.plateau,
      override: overrides[unitOverrideKey(level, u.key)] ?? null,
      nextMonth: u.projection[0] ?? null,
    }))
  }
  return out
}

export const GET = adminRoute(async (_request, _params, admin) => {
  const [units, overrides] = await Promise.all([loadUnits(admin), getForecastUnitOverrides()])
  return json(await payload(admin, units, overrides))
})

export const PUT = adminRoute(async (request, _params, admin) => {
  const body = await parseBody(request, putSchema)
  const units = await loadUnits(admin)
  if (body.key !== UNASSIGNED_KEY && !units[body.level].some((u) => u.id === body.key)) {
    throw new HttpError(404, `Unknown ${body.level}`)
  }
  const overrides = await setForecastUnitOverride(body.level, body.key, {
    plateauUsd: body.plateauUsd ?? null,
    headcount: body.headcount ?? null,
  })
  return json(await payload(admin, units, overrides))
})
