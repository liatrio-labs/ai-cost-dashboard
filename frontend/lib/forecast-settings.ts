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

interface StoredForecast {
  employees?: unknown
  baseline_employees?: unknown
  baseline_plateau_usd?: unknown
  per_person_pct?: unknown
}

function coerce(raw: StoredForecast | null | undefined): ForecastSettings {
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
    return coerce((data as { value: StoredForecast | null }).value)
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
    } as never, // app_settings is not in the generated Database types
    { onConflict: "key" }
  )
  if (error) throw new Error(`Failed to save forecast settings: ${error.message}`)
  return next
}

// ---------------------------------------------------------------------------
// Per-unit (team / department) overrides, issue #9. Stored in app_settings
// under key 'forecast_units' as { overrides: { "<level>:<id|unassigned>":
// { plateau_usd, headcount } } }. See lib/unit-forecast.ts.
// ---------------------------------------------------------------------------

export const FORECAST_UNITS_KEY = "forecast_units"

export type UnitLevel = "department" | "team"
export const UNIT_LEVELS: readonly UnitLevel[] = ["department", "team"]

export interface UnitOverride {
  plateauUsd?: number | null
  headcount?: number | null
}

/** Keyed by unitOverrideKey(level, key). */
export type UnitOverrides = Record<string, UnitOverride>

export const unitOverrideKey = (level: UnitLevel, key: string) => `${level}:${key}`

/** Normalize a stored overrides blob (app_settings value) into UnitOverrides. */
export function coerceUnitOverrides(raw: unknown): UnitOverrides {
  const out: UnitOverrides = {}
  const src = (raw as { overrides?: unknown } | null)?.overrides
  if (!src || typeof src !== "object") return out
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    const [level, ...rest] = k.split(":")
    if (!UNIT_LEVELS.includes(level as UnitLevel) || !rest.join(":")) continue
    const num = (x: unknown) => {
      if (x === null || x === undefined || x === "") return null
      const n = Number(x)
      return Number.isFinite(n) && n >= 0 ? n : null
    }
    const o = v as { plateau_usd?: unknown; headcount?: unknown } | null
    const plateauUsd = num(o?.plateau_usd)
    const headcount = num(o?.headcount)
    if (plateauUsd === null && headcount === null) continue
    out[k] = { plateauUsd, headcount }
  }
  return out
}

/** Inverse of coerceUnitOverrides (snake_case for app_settings). */
export function serializeUnitOverrides(o: UnitOverrides): { overrides: Record<string, { plateau_usd: number | null; headcount: number | null }> } {
  const overrides: Record<string, { plateau_usd: number | null; headcount: number | null }> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v.plateauUsd == null && v.headcount == null) continue
    overrides[k] = { plateau_usd: v.plateauUsd ?? null, headcount: v.headcount ?? null }
  }
  return { overrides }
}

/** Read the per-unit overrides (service-role; {} on any error). */
export async function getForecastUnitOverrides(): Promise<UnitOverrides> {
  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from("app_settings")
      .select("value")
      .eq("key", FORECAST_UNITS_KEY)
      .maybeSingle()
    if (error || !data) return {}
    return coerceUnitOverrides((data as { value: unknown }).value)
  } catch {
    return {}
  }
}

/** Set (or with both fields null, clear) one unit's override. Returns all overrides. */
export async function setForecastUnitOverride(
  level: UnitLevel,
  key: string,
  override: UnitOverride
): Promise<UnitOverrides> {
  const current = await getForecastUnitOverrides()
  const k = unitOverrideKey(level, key)
  const next: UnitOverrides = { ...current }
  if (override.plateauUsd == null && override.headcount == null) delete next[k]
  else next[k] = { plateauUsd: override.plateauUsd ?? null, headcount: override.headcount ?? null }
  const admin = createAdminClient()
  const { error } = await admin.from("app_settings").upsert(
    { key: FORECAST_UNITS_KEY, value: serializeUnitOverrides(next), updated_at: new Date().toISOString() } as never,
    { onConflict: "key" }
  )
  if (error) throw new Error(`Failed to save forecast overrides: ${error.message}`)
  return next
}
