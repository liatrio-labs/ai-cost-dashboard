/**
 * Per-provider sync freshness (issue #47). Pure: no I/O.
 *
 * - API providers with a cron in vercel.json (path /api/cron/<providers.name>)
 *   are "fresh" when providers.last_collected_at (migration 008) covers the
 *   most recent scheduled run that should have finished by now (run time +
 *   grace), and "stale" (missed cron) when it doesn't. A provider whose last
 *   sync is older than its cron interval + grace is always stale; checking
 *   against the scheduled run also catches an off-schedule pull (e.g. an admin
 *   "Pull now" yesterday afternoon) followed by a missed nightly run.
 * - API providers with no last_collected_at are "never" synced.
 * - Manual providers (metadata.collection_method = "manual", e.g. ChatGPT) are
 *   "manual_missing" from day 4 of the month (America/Chicago) until the
 *   current month has an entry, otherwise "manual_ok".
 * - An API provider with no cron (nothing to compare against) is "unscheduled".
 *
 * Crons run in UTC (Vercel). Times are shown in America/Chicago.
 */

import { userFacingProviderName } from "@/lib/cost-types"

export const DISPLAY_TIME_ZONE = "America/Chicago"

export type FreshnessState = "fresh" | "stale" | "never" | "manual_ok" | "manual_missing" | "unscheduled"

export interface CronEntry {
  path: string
  schedule: string
}

export interface FreshnessProvider {
  id: string
  /** providers.name (slug). */
  name: string
  display_name?: string | null
  last_collected_at?: string | null
  metadata?: Record<string, unknown> | null
}

export interface FreshnessOptions {
  now?: Date
  /** Minutes after a scheduled run before it counts as missed. Default 60. */
  graceMinutes?: number
  /**
   * Minutes before a scheduled run that a sync still counts for it. Vercel
   * Hobby fires a cron anywhere within its hour, so default 60.
   */
  earlyMinutes?: number
  /** Manual reminder starts after this day of the month (CT). Default 3. */
  manualReminderAfterDay?: number
}

export interface ProviderFreshness {
  id: string
  slug: string
  name: string
  state: FreshnessState
  lastSyncedAt: string | null
  /** Cron schedule (UTC) from vercel.json, null for manual / unscheduled. */
  schedule: string | null
  /** The scheduled run (ISO, UTC) the sync was checked against; stale/fresh only. */
  expectedRunAt: string | null
  /** True for states that should show a warning (stale, never, manual_missing). */
  warning: boolean
}

export const FRESHNESS_DEFAULTS = { graceMinutes: 60, earlyMinutes: 60, manualReminderAfterDay: 3 } as const

const MINUTE_MS = 60_000
/** How far back to search for a scheduled run (covers weekly crons). */
const SEARCH_MINUTES = 8 * 24 * 60

const WARNING_STATES: ReadonlySet<FreshnessState> = new Set(["stale", "never", "manual_missing"])

// ---------------------------------------------------------------------------
// Cron parsing (5-field, UTC): *, */n, a, a-b, a-b/n and comma lists.
// ---------------------------------------------------------------------------

type FieldSet = Set<number>

function parseField(field: string, min: number, max: number): FieldSet | null {
  const out = new Set<number>()
  for (const part of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) return null
    const step = m[4] ? Number(m[4]) : 1
    if (step < 1) return null
    let lo = min
    let hi = max
    if (m[1] !== "*") {
      lo = Number(m[2])
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

interface ParsedCron {
  minute: FieldSet
  hour: FieldSet
  dom: FieldSet
  month: FieldSet
  dow: FieldSet
  domAny: boolean
  dowAny: boolean
}

export function parseCron(schedule: string): ParsedCron | null {
  const f = schedule.trim().split(/\s+/)
  if (f.length !== 5) return null
  const minute = parseField(f[0], 0, 59)
  const hour = parseField(f[1], 0, 23)
  const dom = parseField(f[2], 1, 31)
  const month = parseField(f[3], 1, 12)
  const dow = parseField(f[4], 0, 7)
  if (!minute || !hour || !dom || !month || !dow) return null
  if (dow.has(7)) dow.add(0) // 7 is Sunday too
  return { minute, hour, dom, month, dow, domAny: f[2] === "*", dowAny: f[4] === "*" }
}

function matches(c: ParsedCron, d: Date): boolean {
  if (!c.minute.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.month.has(d.getUTCMonth() + 1)) return false
  const domOk = c.dom.has(d.getUTCDate())
  const dowOk = c.dow.has(d.getUTCDay())
  // Standard cron: when both day fields are restricted, either may match.
  if (!c.domAny && !c.dowAny) return domOk || dowOk
  return domOk && dowOk
}

/** The latest scheduled run at or before `at` (minute precision, UTC), or null. */
export function previousRun(schedule: string, at: Date): Date | null {
  const c = parseCron(schedule)
  if (!c) return null
  const start = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS
  for (let i = 0; i <= SEARCH_MINUTES; i++) {
    const d = new Date(start - i * MINUTE_MS)
    if (matches(c, d)) return d
  }
  return null
}

/** providers.name -> cron schedule, for crons at /api/cron/<name>. */
export function cronSchedulesByProvider(crons: CronEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of crons) {
    const m = /^\/?api\/cron\/([^/?#]+)/.exec(c.path)
    if (m) out.set(m[1], c.schedule)
  }
  return out
}

// ---------------------------------------------------------------------------
// Months and display (America/Chicago)
// ---------------------------------------------------------------------------

function zonedParts(d: Date, timeZone = DISPLAY_TIME_ZONE): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  return { year: get("year"), month: get("month"), day: get("day") }
}

/** Current month (YYYY-MM) and day of month in America/Chicago. */
export function chicagoMonthAndDay(now: Date): { month: string; day: number } {
  const p = zonedParts(now)
  return { month: `${p.year}-${String(p.month).padStart(2, "0")}`, day: p.day }
}

/** "Nov 4, 2:55 AM CST" in America/Chicago. */
export function formatChicago(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return "unknown"
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d)
}

/** "just now", "12m ago", "3h ago", "2d ago". */
export function formatRelative(iso: string | Date, now: Date = new Date()): string {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime()
  if (Number.isNaN(t)) return "unknown"
  const mins = Math.floor((now.getTime() - t) / MINUTE_MS)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function isManualProvider(p: Pick<FreshnessProvider, "metadata">): boolean {
  return p.metadata?.collection_method === "manual"
}

export interface FreshnessInput {
  providers: FreshnessProvider[]
  crons: CronEntry[]
  /** Provider ids with at least one cost record in the current CT month. */
  manualEntryThisMonth: ReadonlySet<string>
}

export function providerFreshness(
  p: FreshnessProvider,
  schedule: string | null,
  hasEntryThisMonth: boolean,
  opts: FreshnessOptions = {}
): ProviderFreshness {
  const now = opts.now ?? new Date()
  const grace = (opts.graceMinutes ?? FRESHNESS_DEFAULTS.graceMinutes) * MINUTE_MS
  const early = (opts.earlyMinutes ?? FRESHNESS_DEFAULTS.earlyMinutes) * MINUTE_MS
  const afterDay = opts.manualReminderAfterDay ?? FRESHNESS_DEFAULTS.manualReminderAfterDay

  const lastMs = p.last_collected_at ? Date.parse(p.last_collected_at) : NaN
  const lastSyncedAt = Number.isNaN(lastMs) ? null : new Date(lastMs).toISOString()
  const base = { id: p.id, slug: p.name, name: userFacingProviderName(p.name, p.display_name), lastSyncedAt }
  const result = (state: FreshnessState, sched: string | null, expectedRunAt: string | null): ProviderFreshness => ({
    ...base,
    state,
    schedule: sched,
    expectedRunAt,
    warning: WARNING_STATES.has(state),
  })

  if (isManualProvider(p)) {
    const missing = !hasEntryThisMonth && chicagoMonthAndDay(now).day > afterDay
    return result(missing ? "manual_missing" : "manual_ok", null, null)
  }
  if (!schedule || !parseCron(schedule)) return result(lastSyncedAt ? "unscheduled" : "never", null, null)
  if (!lastSyncedAt) return result("never", schedule, null)

  // The latest run that should have finished by now.
  const due = previousRun(schedule, new Date(now.getTime() - grace))
  if (!due) return result("fresh", schedule, null)
  const stale = lastMs < due.getTime() - early
  return result(stale ? "stale" : "fresh", schedule, due.toISOString())
}

/**
 * Freshness for providers that have a cron or are manual, in input order.
 * API providers with no cron and no sync (e.g. removed collectors whose rows
 * linger) are left out so they don't raise a permanent "never synced" warning.
 */
export function computeFreshness(input: FreshnessInput, opts: FreshnessOptions = {}): ProviderFreshness[] {
  const schedules = cronSchedulesByProvider(input.crons)
  const out: ProviderFreshness[] = []
  for (const p of input.providers) {
    const schedule = schedules.get(p.name) ?? null
    if (!schedule && !isManualProvider(p)) continue
    out.push(providerFreshness(p, schedule, input.manualEntryThisMonth.has(p.id), opts))
  }
  return out
}

/** Short badge label, e.g. "Missed sync", "No Nov entry". */
export function freshnessLabel(f: ProviderFreshness, now: Date = new Date()): string {
  switch (f.state) {
    case "fresh":
    case "unscheduled":
      return f.lastSyncedAt ? `Synced ${formatRelative(f.lastSyncedAt, now)}` : "Synced"
    case "stale":
      return "Missed sync"
    case "never":
      return "Never synced"
    case "manual_missing": {
      const ym = chicagoMonthAndDay(now).month
      const name = new Date(`${ym}-01T12:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" })
      return `No ${name} entry`
    }
    case "manual_ok":
      return "Manual entry"
  }
}

/** One-line detail for a tooltip or warning list. Times in America/Chicago. */
export function freshnessDetail(f: ProviderFreshness, now: Date = new Date()): string {
  const last = f.lastSyncedAt ? `Last synced ${formatChicago(f.lastSyncedAt)} (${formatRelative(f.lastSyncedAt, now)})` : "Never synced"
  switch (f.state) {
    case "stale":
      return `${f.name} missed its ${f.expectedRunAt ? formatChicago(f.expectedRunAt) : "scheduled"} sync. ${last}.`
    case "never":
      return `${f.name} has never synced.`
    case "manual_missing": {
      const { month } = chicagoMonthAndDay(now)
      const label = new Date(`${month}-01T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
      return `${f.name} has no ${label} entry yet. Add it in Admin > Monthly entry.`
    }
    case "manual_ok":
      return f.lastSyncedAt ? `${f.name}: manual entry. Last updated ${formatChicago(f.lastSyncedAt)}.` : `${f.name}: manual entry.`
    default:
      return `${f.name}: ${last}.`
  }
}
