/**
 * Team / department forecasts (issue #9).
 *
 * The org forecast is a saturating projection: starting from an anchor (the
 * larger of the last two real months), each future month closes
 * FORECAST_APPROACH of the remaining gap to a headcount-driven plateau.
 *
 * Units (departments or teams, plus an explicit Unassigned unit) reuse the
 * same model with their own plateau and anchor:
 *
 *   share_u   = unit spend / org spend over the trailing 3 calendar months
 *               (ending at the org's last month with data)
 *   plateau_u = org plateau x share_u            (unless overridden)
 *   anchor_u  = unit spend in the org's anchor month
 *
 * Because the recurrence v' = v + (C - v) * a is linear in (v, C), and the
 * unit plateaus and anchors each sum to the org's, the unit projections sum
 * to the org projection for every future month (up to cent rounding).
 *
 * Admin overrides (app_settings key "forecast_units") replace one unit's
 * plateau, either directly (plateauUsd) or via headcount at the org's
 * per-employee plateau (orgPlateau / employees). An override changes only
 * that unit, so with overrides the units no longer have to sum to the org.
 *
 * Per-person and per-key forecasts are out of scope (too noisy); callers show
 * a trailing average instead (trailingAverage below).
 *
 * Projected current month (issue #39): given a projection context, the anchor
 * month is the current calendar month and each unit's anchor is its projected
 * current month (lib/projection.ts) instead of a partial month's actuals. The
 * org anchor is the sum of the unit anchors, so units still sum to the org.
 */

import {
  plateauForEmployees,
  unitOverrideKey,
  type ForecastSettings,
  type UnitLevel,
  type UnitOverride,
  type UnitOverrides,
} from "@/lib/forecast-settings"

export { UNIT_LEVELS, coerceUnitOverrides, serializeUnitOverrides, unitOverrideKey } from "@/lib/forecast-settings"
export type { UnitLevel, UnitOverride, UnitOverrides } from "@/lib/forecast-settings"
import { AUTOMATION_KEY, UNASSIGNED_KEY } from "@/lib/org/rollup"
import { monthRange, projectPeriod, type ProjectionContext } from "@/lib/projection"

/** Fraction of the remaining gap to the plateau closed each month. */
export const FORECAST_APPROACH = 0.45
export const TRAILING_MONTHS = 3

export interface MonthTotal {
  month: string // YYYY-MM
  total: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

const monthOf = (d: string) => d.slice(0, 7)

export function nextMonth(ym: string): string {
  const [y, mo] = ym.split("-").map(Number)
  const d = new Date(Date.UTC(y, mo, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

export function prevMonth(ym: string): string {
  const [y, mo] = ym.split("-").map(Number)
  const d = new Date(Date.UTC(y, mo - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

interface CostRow {
  date: string
  total_cost_usd: number | string
}

/** Per-month totals (rounded to cents), oldest first. */
export function monthlyTotals(rows: CostRow[]): MonthTotal[] {
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = monthOf(r.date)
    m.set(k, (m.get(k) || 0) + (Number(r.total_cost_usd) || 0))
  }
  return [...m.keys()].sort().map((month) => ({ month, total: round2(m.get(month) || 0) }))
}

/**
 * Index of the anchor month: the larger of the last two real months (the
 * current month is usually incomplete). Ties go to the later month. -1 when
 * there is no history.
 */
export function anchorIndex(history: MonthTotal[]): number {
  const n = history.length
  if (n === 0) return -1
  if (n === 1) return 0
  return history[n - 1].total >= history[n - 2].total ? n - 1 : n - 2
}

/**
 * Saturating projection from `anchor` toward `ceiling`, one point per month
 * after `lastMonth` through December of that year (at most 12 points).
 */
export function saturatingProjection(lastMonth: string, anchor: number, ceiling: number): MonthTotal[] {
  const out: MonthTotal[] = []
  const endOfYear = `${lastMonth.slice(0, 4)}-12`
  let cursor = lastMonth
  let value = anchor
  for (let i = 0; i < 12 && cursor < endOfYear; i++) {
    cursor = nextMonth(cursor)
    value = value + (ceiling - value) * FORECAST_APPROACH
    out.push({ month: cursor, total: round2(value) })
  }
  return out
}

/** The org projection exactly as /api/dashboard has always computed it. */
export function orgProjection(history: MonthTotal[], ceiling: number): MonthTotal[] {
  const i = anchorIndex(history)
  if (i < 0) return []
  return saturatingProjection(history[history.length - 1].month, history[i].total, ceiling)
}

/** The `TRAILING_MONTHS` calendar months ending at `lastMonth`, oldest first. */
export function trailingWindow(lastMonth: string, n = TRAILING_MONTHS): string[] {
  const out = [lastMonth]
  while (out.length < n) out.unshift(prevMonth(out[0]))
  return out
}

/** Average monthly spend over the trailing window (missing months count as $0). */
export function trailingAverage(rows: CostRow[], lastMonth: string, n = TRAILING_MONTHS): number {
  const window = new Set(trailingWindow(lastMonth, n))
  let sum = 0
  for (const r of rows) if (window.has(monthOf(r.date))) sum += Number(r.total_cost_usd) || 0
  return round2(sum / n)
}

export interface UnitRow extends CostRow {
  department_id: string | null
  team_id: string | null
  provider_id?: string | null
  model_name?: string | null
}

export interface UnitForecast {
  level: UnitLevel
  /** Entity id, or "unassigned". */
  key: string
  unassigned: boolean
  /** Unit spend over the trailing window. */
  trailingSpend: number
  /** trailingSpend / org trailing spend (0..1). */
  share: number
  /** Unit spend in the org's anchor month. */
  anchor: number
  /** org plateau x share. */
  allocatedPlateau: number
  /** The plateau actually used (override or allocated). */
  plateau: number
  override: "plateau" | "headcount" | null
  history: MonthTotal[]
  projection: MonthTotal[]
}

export interface UnitForecastResult {
  level: UnitLevel
  orgPlateau: number
  orgHistory: MonthTotal[]
  orgProjection: MonthTotal[]
  anchorMonth: string | null
  trailingMonths: string[]
  units: UnitForecast[]
}

export interface ComputeUnitForecastsInput {
  rows: UnitRow[]
  level: UnitLevel
  settings: ForecastSettings
  overrides?: UnitOverrides
  /** Unit keys to include even with no spend (e.g. every team in the org). */
  include?: string[]
  /** Anchor on the projected current month (issue #39). Omit for the pre-#39 anchor. */
  current?: ProjectionContext
}

/** Plateau an override implies, or null when it has none. */
export function overridePlateau(
  o: UnitOverride | undefined,
  orgPlateau: number,
  employees: number
): { plateau: number; kind: "plateau" | "headcount" } | null {
  if (!o) return null
  if (o.plateauUsd != null && Number.isFinite(o.plateauUsd)) {
    return { plateau: Math.max(0, o.plateauUsd), kind: "plateau" }
  }
  if (o.headcount != null && Number.isFinite(o.headcount)) {
    const perHead = employees > 0 ? orgPlateau / employees : 0
    return { plateau: Math.max(0, o.headcount) * perHead, kind: "headcount" }
  }
  return null
}

const unitKeyOf = (r: UnitRow, level: UnitLevel) =>
  (level === "team" ? r.team_id : r.department_id) ?? UNASSIGNED_KEY

export function computeUnitForecasts({
  rows,
  level,
  settings,
  overrides = {},
  include = [],
  current,
}: ComputeUnitForecastsInput): UnitForecastResult {
  const orgPlateau = plateauForEmployees(settings)
  const orgHistory = monthlyTotals(rows)
  const ai = anchorIndex(orgHistory)
  const lastMonth = orgHistory.length ? orgHistory[orgHistory.length - 1].month : null
  // Projected current month (issue #39), when the data doesn't run past it.
  const currentMonth = current && lastMonth && current.today.slice(0, 7) >= lastMonth ? current.today.slice(0, 7) : null
  const anchorMonth = currentMonth ?? (ai >= 0 ? orgHistory[ai].month : null)
  const projectFrom = currentMonth ?? lastMonth
  const trailingMonths = lastMonth ? trailingWindow(lastMonth) : []
  const window = new Set(trailingMonths)

  const rowsByUnit = new Map<string, UnitRow[]>()
  for (const k of include) rowsByUnit.set(k, [])
  for (const r of rows) {
    const k = unitKeyOf(r, level)
    if (!rowsByUnit.has(k)) rowsByUnit.set(k, [])
    rowsByUnit.get(k)!.push(r)
  }
  // Unassigned is always its own unit.
  if (!rowsByUnit.has(UNASSIGNED_KEY)) rowsByUnit.set(UNASSIGNED_KEY, [])

  const trailing = new Map<string, number>()
  const anchors = new Map<string, number>()
  let orgTrailing = 0
  for (const [k, unitRows] of rowsByUnit) {
    let t = 0
    let a = 0
    for (const r of unitRows) {
      const cost = Number(r.total_cost_usd) || 0
      const m = monthOf(r.date)
      if (window.has(m)) t += cost
      if (m === anchorMonth) a += cost
    }
    trailing.set(k, t)
    anchors.set(k, currentMonth ? projectPeriod(unitRows, monthRange(currentMonth), current!)!.projected : a)
    orgTrailing += t
  }

  const units: UnitForecast[] = []
  for (const [k, unitRows] of rowsByUnit) {
    const t = trailing.get(k) || 0
    // No trailing org spend at all: Unassigned carries the whole org so the
    // units still sum to the org forecast.
    const share = orgTrailing > 0 ? Math.max(0, t / orgTrailing) : k === UNASSIGNED_KEY ? 1 : 0
    const allocatedPlateau = orgPlateau * share
    const o = overridePlateau(overrides[unitOverrideKey(level, k)], orgPlateau, settings.employees)
    const plateau = o ? o.plateau : allocatedPlateau
    const anchor = anchors.get(k) || 0
    units.push({
      level,
      key: k,
      unassigned: k === UNASSIGNED_KEY,
      trailingSpend: round2(t),
      share,
      anchor: round2(anchor),
      allocatedPlateau: round2(allocatedPlateau),
      plateau: round2(plateau),
      override: o ? o.kind : null,
      history: monthlyTotals(unitRows),
      projection: projectFrom ? saturatingProjection(projectFrom, anchor, plateau) : [],
    })
  }
  // Largest trailing spend first; Unassigned last.
  units.sort((a, b) => Number(a.unassigned) - Number(b.unassigned) || b.trailingSpend - a.trailingSpend || a.key.localeCompare(b.key))

  return {
    level,
    orgPlateau: round2(orgPlateau),
    orgHistory,
    orgProjection: currentMonth
      ? saturatingProjection(currentMonth, [...anchors.values()].reduce((s, a) => s + a, 0), orgPlateau)
      : orgProjection(orgHistory, orgPlateau),
    anchorMonth,
    trailingMonths,
    units,
  }
}

/** Which unit forecast a dashboard filter maps to, or null for none. */
export function forecastUnitForFilters(f: {
  department?: string
  team?: string
  person?: string
  key?: string
  project?: string
  provider?: string
}): { level: UnitLevel; key: string } | null {
  if (f.person || f.key || f.project || f.provider) return null
  // The Cursor automation line (issue #51) is not a forecastable unit.
  if (f.team === AUTOMATION_KEY || f.department === AUTOMATION_KEY) return null
  if (f.team) return { level: "team", key: f.team }
  if (f.department) return { level: "department", key: f.department }
  return null
}
