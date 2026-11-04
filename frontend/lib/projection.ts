/**
 * Current-period projection (issue #39). Pure: callers pass the rows of one
 * entity (org, provider, department, team, person, key or project) and a
 * context built from the providers' `last_collected_at`. See docs/projections.md.
 *
 * Method:
 * - Complete days. A day is complete for a provider when its last_collected_at
 *   is after the end of that day (UTC). Today is never complete. A provider
 *   with no last_collected_at (manual entry) is complete through yesterday.
 *   Rows on incomplete days count as actuals but don't drive the rate.
 * - Seat vs usage. Rows dated the 1st of a month from a monthly-seat provider
 *   (ChatGPT Business, Claude Ultra `claude-max`), or any row on the 1st with
 *   model_name 'seats' (e.g. Cursor seat rows, if any) or 'recurring' (a
 *   recurring flat monthly cost, issue #59), are seat spend. Everything else
 *   is usage.
 * - Usage. Per provider, for each remaining day of the period (days after the
 *   provider's last complete day), expected spend =
 *     w x period average for that day type + (1 - w) x trailing average for it
 *   where day type is weekday or weekend (UTC), the period average is over the
 *   complete days of the period, the trailing average is over the 28 complete
 *   days ending at the provider's last complete day, and
 *   w = min(1, complete days in the period / 14). A day type with no complete
 *   day in the period yet uses the trailing average alone. A remaining day
 *   that already logged spend adds only max(0, expected - logged).
 * - Seats. Seat rows already billed in the period count as-is. A provider that
 *   billed seats on the previous month's 1st but not yet on this month's 1st
 *   is projected at the previous month's amount.
 * - Projected = all actual rows in the period + projected usage + projected
 *   seats. Actual totals are never changed; projections are separate numbers.
 *
 * Only a period that contains today is projected. Past periods compare actual
 * with actual; future periods have no projection.
 */

export const BLEND_DAYS = 14
export const TRAILING_DAYS = 28
/** providers.name of providers billed as one seat row on the 1st of each month. */
export const MONTHLY_SEAT_PROVIDERS = ["chatgpt", "claude-max"] as const
export const SEAT_MODEL = "seats"
/** model_name of a recurring flat monthly cost row (issue #59, lib/recurring-costs.ts). */
export const RECURRING_MODEL = "recurring"

const DAY_MS = 86400000

export interface ProjectionRow {
  date: string // YYYY-MM-DD
  provider_id?: string | null
  model_name?: string | null
  total_cost_usd: number | string
}

export interface ProjectionProvider {
  id: string
  name: string
  last_collected_at?: string | null
}

export interface ProjectionContext {
  /** Today's date (UTC), YYYY-MM-DD. Never complete. */
  today: string
  /** provider id -> last complete day (YYYY-MM-DD). */
  completeThrough: Record<string, string>
  /** Last complete day for providers not in completeThrough (yesterday). */
  defaultCompleteThrough: string
  seatProviderIds: string[]
}

export interface Period {
  start: string
  end: string
}

export type PeriodStatus = "past" | "current" | "future"

export interface PeriodProjection {
  start: string
  end: string
  /** Every row in the period, rounded to cents. Same as the actual total. */
  actual: number
  projected: number
  usageActual: number
  usageProjected: number
  seatActual: number
  seatProjected: number
  /** Complete days in the period for the least-complete provider with usage. */
  completeDays: number
  /** That provider's last complete day, or null before the period's first complete day. */
  completeThrough: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const minDate = (a: string, b: string) => (a < b ? a : b)
const maxDate = (a: string, b: string) => (a > b ? a : b)

export function isWeekend(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return d === 0 || d === 6
}

/** First and last day of a YYYY-MM month. */
export function monthRange(ym: string): Period {
  const [y, m] = ym.split("-").map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, "0")}` }
}

/** The 1st of the month before the month containing `iso`. */
function prevMonthStart(iso: string): string {
  const [y, m] = iso.split("-").map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return d.toISOString().slice(0, 10)
}

function nextMonthStart(iso: string): string {
  const [y, m] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
}

export const todayOf = (now: Date) => now.toISOString().slice(0, 10)

/**
 * Last complete day for a provider: the latest day D whose end (D+1 00:00 UTC)
 * is before last_collected_at, capped at yesterday. Null or unparseable
 * last_collected_at (manual providers) -> yesterday.
 */
export function lastCompleteDay(lastCollectedAt: string | null | undefined, today: string): string {
  const yesterday = addDays(today, -1)
  const t = lastCollectedAt ? Date.parse(lastCollectedAt) : NaN
  if (!Number.isFinite(t)) return yesterday
  const collectedDay = new Date(t - 1).toISOString().slice(0, 10) // strictly after the day's end
  return minDate(addDays(collectedDay, -1), yesterday)
}

export function projectionContext(providers: ProjectionProvider[], now: Date): ProjectionContext {
  const today = todayOf(now)
  const completeThrough: Record<string, string> = {}
  for (const p of providers) completeThrough[p.id] = lastCompleteDay(p.last_collected_at, today)
  const seat = new Set<string>(MONTHLY_SEAT_PROVIDERS)
  return {
    today,
    completeThrough,
    defaultCompleteThrough: addDays(today, -1),
    seatProviderIds: providers.filter((p) => seat.has(p.name)).map((p) => p.id),
  }
}

export function periodStatus(period: Period, today: string): PeriodStatus {
  if (period.end < today) return "past"
  if (period.start > today) return "future"
  return "current"
}

export function isSeatRow(r: ProjectionRow, ctx: ProjectionContext): boolean {
  if (!r.date.endsWith("-01")) return false
  return r.model_name === SEAT_MODEL || r.model_name === RECURRING_MODEL || (!!r.provider_id && ctx.seatProviderIds.includes(r.provider_id))
}

const completeThroughOf = (ctx: ProjectionContext, providerId: string) =>
  minDate(ctx.completeThrough[providerId] ?? ctx.defaultCompleteThrough, ctx.defaultCompleteThrough)

/** Percent change of a projection vs a full comparison period, 1 decimal; null with no prior spend ("new"). */
export function projectedChangePercent(projected: number, compare: number): number | null {
  if (!(compare > 0) || !Number.isFinite(projected)) return null
  return Math.round(((projected - compare) / compare) * 1000) / 10
}

/** Earliest date any projection for `period` reads (trailing windows and last month's seats). */
export function projectionWindowStart(period: Period, ctx: ProjectionContext): string {
  let lo = minDate(prevMonthStart(period.start), addDays(ctx.defaultCompleteThrough, 1 - TRAILING_DAYS))
  for (const ct of Object.values(ctx.completeThrough)) lo = minDate(lo, addDays(minDate(ct, ctx.defaultCompleteThrough), 1 - TRAILING_DAYS))
  return lo
}

interface ProviderAcc {
  usage: Map<string, number>
  seats: Map<string, number>
  hasUsage: boolean
}

function usageExtra(acc: ProviderAcc, period: Period, ct: string): { extra: number; completeDays: number } {
  const type = (d: string) => (isWeekend(d) ? 1 : 0)
  const curSum = [0, 0]
  const curN = [0, 0]
  for (let d = period.start; d <= minDate(ct, period.end); d = addDays(d, 1)) {
    curSum[type(d)] += acc.usage.get(d) ?? 0
    curN[type(d)] += 1
  }
  const completeDays = curN[0] + curN[1]
  const w = Math.min(1, completeDays / BLEND_DAYS)
  const trSum = [0, 0]
  const trN = [0, 0]
  for (let d = addDays(ct, 1 - TRAILING_DAYS); d <= ct; d = addDays(d, 1)) {
    trSum[type(d)] += acc.usage.get(d) ?? 0
    trN[type(d)] += 1
  }
  const expected = [0, 1].map((t) => {
    const trailing = trN[t] ? trSum[t] / trN[t] : 0
    return curN[t] ? w * (curSum[t] / curN[t]) + (1 - w) * trailing : trailing
  })
  let extra = 0
  for (let d = maxDate(period.start, addDays(ct, 1)); d <= period.end; d = addDays(d, 1)) {
    extra += Math.max(0, expected[type(d)] - (acc.usage.get(d) ?? 0))
  }
  return { extra, completeDays }
}

function seatExtra(acc: ProviderAcc, period: Period): number {
  if (acc.seats.size === 0) return 0
  let extra = 0
  let carried: number | undefined
  let first = period.start.endsWith("-01") ? period.start : nextMonthStart(period.start)
  for (; first <= period.end; first = nextMonthStart(first)) {
    if (acc.seats.has(first)) {
      carried = undefined
      continue
    }
    const prior = acc.seats.get(prevMonthStart(first)) ?? carried
    if (prior && prior > 0) {
      extra += prior
      carried = prior
    } else carried = undefined
  }
  return extra
}

/**
 * Projection of one entity's rows for a period, or null when the period
 * doesn't contain today (past and future periods aren't projected).
 */
export function projectPeriod(rows: ProjectionRow[], period: Period, ctx: ProjectionContext): PeriodProjection | null {
  if (periodStatus(period, ctx.today) !== "current") return null
  const lo = projectionWindowStart(period, ctx)
  const accs = new Map<string, ProviderAcc>()
  let usageActual = 0
  let seatActual = 0
  for (const r of rows) {
    if (r.date < lo || r.date > period.end) continue
    const pid = r.provider_id ?? ""
    const acc = accs.get(pid) ?? { usage: new Map(), seats: new Map(), hasUsage: false }
    accs.set(pid, acc)
    const cost = num(r.total_cost_usd)
    const seat = isSeatRow(r, ctx)
    const m = seat ? acc.seats : acc.usage
    m.set(r.date, (m.get(r.date) ?? 0) + cost)
    if (!seat) acc.hasUsage = true
    if (r.date >= period.start) {
      if (seat) seatActual += cost
      else usageActual += cost
    }
  }

  let usageExtraSum = 0
  let seatExtraSum = 0
  let least: { days: number; through: string } | null = null
  for (const [pid, acc] of accs) {
    seatExtraSum += seatExtra(acc, period)
    if (!acc.hasUsage) continue
    const ct = completeThroughOf(ctx, pid)
    const u = usageExtra(acc, period, ct)
    usageExtraSum += u.extra
    if (!least || u.completeDays < least.days) least = { days: u.completeDays, through: ct }
  }
  if (!least) {
    const ct = ctx.defaultCompleteThrough
    const days = ct < period.start ? 0 : Math.round((Date.parse(minDate(ct, period.end)) - Date.parse(period.start)) / DAY_MS) + 1
    least = { days, through: ct }
  }

  const actual = usageActual + seatActual
  return {
    start: period.start,
    end: period.end,
    actual: round2(actual),
    projected: round2(actual + usageExtraSum + seatExtraSum),
    usageActual: round2(usageActual),
    usageProjected: round2(usageActual + usageExtraSum),
    seatActual: round2(seatActual),
    seatProjected: round2(seatActual + seatExtraSum),
    completeDays: least.days,
    completeThrough: least.days > 0 ? least.through : null,
  }
}

/**
 * projectPeriod for every entity at once: rows are grouped by `keyOf` (only
 * rows inside the projection window are kept). Empty for a past or future
 * period. Keys with no rows in the window aren't in the map (projected = actual = 0).
 */
export function projectByKey<R extends ProjectionRow>(
  rows: R[],
  keyOf: (r: R) => string,
  period: Period,
  ctx: ProjectionContext
): Map<string, PeriodProjection> {
  const out = new Map<string, PeriodProjection>()
  if (periodStatus(period, ctx.today) !== "current") return out
  const lo = projectionWindowStart(period, ctx)
  const groups = new Map<string, R[]>()
  for (const r of rows) {
    if (r.date < lo || r.date > period.end) continue
    const k = keyOf(r)
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  for (const [k, g] of groups) out.set(k, projectPeriod(g, period, ctx)!)
  return out
}
