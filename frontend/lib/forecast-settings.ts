/**
 * Forecast configuration, persisted in app_settings (key = 'forecast') and
 * editable from the admin page. The forecast plateau scales with total
 * employee count: at `baselineEmployees` the plateau is `baselinePlateauUsd`,
 * and each employee above/below adjusts it by `perPersonPct`.
 */

import { createAdminClient } from "@/lib/supabase/admin"

export interface ForecastSettings {
  employees: number
  baselineEmployees: number
  baselinePlateauUsd: number
  perPersonPct: number
}

export const FORECAST_DEFAULTS: ForecastSettings = {
  employees: 160,
  baselineEmployees: 160,
  baselinePlateauUsd: 58000,
  perPersonPct: 0.02,
}

/** Monthly-spend plateau implied by an employee count. */
export function plateauForEmployees(s: ForecastSettings): number {
  const delta = s.employees - s.baselineEmployees
  const plateau = s.baselinePlateauUsd * (1 + s.perPersonPct * delta)
  return Math.max(0, plateau)
}

function coerce(raw: any): ForecastSettings {
  const num = (v: unknown, d: number) => {
    const n = typeof v === "number" ? v : Number(v)
    return Number.isFinite(n) ? n : d
  }
  return {
    employees: Math.max(0, Math.round(num(raw?.employees, FORECAST_DEFAULTS.employees))),
    baselineEmployees: num(raw?.baseline_employees, FORECAST_DEFAULTS.baselineEmployees),
    baselinePlateauUsd: num(raw?.baseline_plateau_usd, FORECAST_DEFAULTS.baselinePlateauUsd),
    perPersonPct: num(raw?.per_person_pct, FORECAST_DEFAULTS.perPersonPct),
  }
}

/** Read the forecast settings (service-role; falls back to defaults). */
export async function getForecastSettings(): Promise<ForecastSettings> {
  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from("app_settings")
      .select("value")
      .eq("key", "forecast")
      .maybeSingle()
    if (error || !data) return { ...FORECAST_DEFAULTS }
    return coerce((data as { value: unknown }).value)
  } catch {
    return { ...FORECAST_DEFAULTS }
  }
}

/** Persist the employee count (other params kept as-is). Returns the new settings. */
export async function setForecastEmployees(employees: number): Promise<ForecastSettings> {
  const current = await getForecastSettings()
  const next = { ...current, employees: Math.max(0, Math.round(employees)) }
  const admin = createAdminClient()
  const { error } = await admin.from("app_settings").upsert(
    {
      key: "forecast",
      value: {
        employees: next.employees,
        baseline_employees: next.baselineEmployees,
        baseline_plateau_usd: next.baselinePlateauUsd,
        per_person_pct: next.perPersonPct,
      },
      updated_at: new Date().toISOString(),
    } as any,
    { onConflict: "key" }
  )
  if (error) throw new Error(`Failed to save forecast settings: ${error.message}`)
  return next
}
