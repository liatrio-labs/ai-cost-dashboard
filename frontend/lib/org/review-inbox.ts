/**
 * Needs-review inbox (issue #44). Pure: GET /api/admin/org/review feeds it
 * cost_records_daily_attributed rows, the org tables, providers and the
 * review_items decisions (migration 018); tests feed it fixtures.
 *
 * Items, computed live every time:
 *
 * - person_spike   a person's month spend > 2x the previous month AND > $500.
 *                  Checked for the last complete month (actual vs actual) and
 *                  the current month, which uses the #39 projection
 *                  (lib/projection.ts) and is labelled projected. A person with
 *                  no spend the month before counts as a spike once over $500.
 * - person_day     a person's spend on one day > $300, from the 1st of the
 *                  last complete month through today.
 * - unassigned_new Unassigned spend (no team) whose group (person, else API
 *                  key, else project, else provider) was first seen in the
 *                  last 7 days (today included) of the loaded window.
 * - key_new        a key the provider created in the last 7 days (only keys
 *                  with org_api_keys.provider_created_at, migration 018) that
 *                  has spend since. Keys without a stored creation date are
 *                  never listed: our own sync date says nothing.
 *
 * Acknowledged or assigned items (review_items) stay hidden until the live
 * amount grows past 1.25x the amount recorded with the decision; then they
 * come back with the earlier decision attached.
 */

import { effectiveProjectId } from "@/lib/dashboard-filters"
import { addDays, monthRange, projectByKey, projectionContext, type ProjectionProvider } from "@/lib/projection"
import type { AttributedDailyRow, OrgData } from "./types"

export const REVIEW_KINDS = ["person_spike", "person_day", "unassigned_new", "key_new"] as const
export type ReviewKind = (typeof REVIEW_KINDS)[number]
export const REVIEW_STATUSES = ["acknowledged", "assigned"] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

export const REVIEW_THRESHOLDS = {
  /** Month spend must be more than this multiple of the previous month. */
  spikeRatio: 2,
  /** ...and more than this many dollars. */
  spikeMinUsd: 500,
  /** One person-day over this many dollars. */
  personDayMinUsd: 300,
  /** "New" = first seen / created within this many days, today included. */
  newDays: 7,
  /** An acknowledged item comes back once its amount exceeds the acknowledged amount x this. */
  regrowthFactor: 1.25,
} as const

/** A review_items row (migration 018). */
export interface ReviewDecision {
  kind: ReviewKind
  subject: string
  period: string
  amount: number | string
  status: ReviewStatus
  note: string | null
  acknowledged_by: string | null
  acknowledged_at: string | null
}

/** Body for POST /api/admin/org/unassigned/assign, minus team_id (the existing assign flow). */
export type AssignTarget =
  | { kind: "person"; email: string; display_name?: string }
  | { kind: "api_key"; provider_id: string; external_key_id: string; name?: string }
  | { kind: "project"; provider_id: string; external_project_id: string; name?: string }

export interface ReviewItem {
  /** `${kind}|${subject}|${period}`: stable across refreshes. */
  id: string
  kind: ReviewKind
  subject: string
  /** YYYY-MM (spikes) or YYYY-MM-DD (days, first-seen and creation dates). */
  period: string
  /** The amount the item is about (projected for a current-month spike). */
  amount: number
  /** True for a current-month spike: amount is the #39 projection. */
  projected: boolean
  /** Spikes: the previous month's spend (0 = none). */
  previousAmount: number | null
  /** Spikes: amount / previousAmount, 1 decimal; null with no previous spend. */
  ratio: number | null
  label: string
  /** One line of context, e.g. "Anthropic, Cursor" or "first seen 2026-11-02". */
  detail: string
  /** What "Assign" sends to the existing assign flow; null when nothing can be assigned. */
  assign: AssignTarget | null
  /** The earlier decision, when the item came back because its amount grew. */
  previous: ReviewDecision | null
}

export interface ReviewInbox {
  today: string
  /** First date of the rows the inbox reads. */
  windowStart: string
  /** Last complete month and the current (projected) month. */
  months: { last: string; current: string }
  thresholds: typeof REVIEW_THRESHOLDS
  items: ReviewItem[]
  /** Items hidden by a decision (amount hasn't grown past the threshold). */
  hiddenCount: number
}

export interface ReviewInboxInput {
  rows: AttributedDailyRow[]
  org: OrgData
  providers: (ProjectionProvider & { display_name?: string | null })[]
  /** review_items rows; empty when migration 018 isn't applied. */
  decisions?: ReviewDecision[]
  now?: Date
}

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
const ym = (iso: string) => iso.slice(0, 7)
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7)
}

export const reviewItemId = (kind: ReviewKind, subject: string, period: string) => `${kind}|${subject}|${period}`

/**
 * First date the inbox needs: the 1st of the month before the last complete
 * month (the spike baseline), which also covers the projection's 28-day
 * trailing window and gives "first seen" at least a month of history.
 */
export function reviewWindowStart(now: Date): string {
  const today = now.toISOString().slice(0, 10)
  return `${shiftMonth(ym(today), -2)}-01`
}

/** Is a decided item still hidden? Only while the amount hasn't grown past regrowthFactor x the decided amount. */
export function isSuppressed(amount: number, decision: Pick<ReviewDecision, "amount"> | undefined): boolean {
  if (!decision) return false
  return round2(amount) <= round2(num(decision.amount) * REVIEW_THRESHOLDS.regrowthFactor)
}

/** A month qualifies as a spike: > spikeRatio x previous (any amount when there was none) and > spikeMinUsd. */
export function isSpike(amount: number, previous: number): boolean {
  if (!(amount > REVIEW_THRESHOLDS.spikeMinUsd)) return false
  return previous > 0 ? amount > REVIEW_THRESHOLDS.spikeRatio * previous : true
}

export function computeReviewInbox({ rows, org, providers, decisions = [], now = new Date() }: ReviewInboxInput): ReviewInbox {
  const ctx = projectionContext(providers, now)
  const today = ctx.today
  const windowStart = reviewWindowStart(now)
  const current = ym(today)
  const last = shiftMonth(current, -1)
  const beforeLast = shiftMonth(current, -2)
  const newSince = addDays(today, 1 - REVIEW_THRESHOLDS.newDays)

  const people = new Map(org.people.map((p) => [p.id, p]))
  const keys = new Map(org.apiKeys.map((k) => [k.id, k]))
  const projects = new Map((org.projects ?? []).map((p) => [`${p.provider_id}\u0000${p.external_project_id}`, p]))
  const providerName = new Map(providers.map((p) => [p.id, p.display_name || p.name]))
  const providerList = (ids: Set<string>) => [...ids].map((id) => providerName.get(id) ?? id).sort().join(", ")
  const personLabel = (id: string) => {
    const p = people.get(id)
    return p ? p.display_name || p.email : id
  }
  const personAssign = (id: string): AssignTarget | null => {
    const p = people.get(id)
    return p ? { kind: "person", email: p.email } : null
  }

  const inWindow = rows.filter((r) => r.date >= windowStart && r.date <= today)
  const candidates: ReviewItem[] = []
  const base = (kind: ReviewKind, subject: string, period: string) => ({ id: reviewItemId(kind, subject, period), kind, subject, period, previous: null })

  // -- Person month totals and providers -------------------------------------
  const monthly = new Map<string, Map<string, number>>() // person -> month -> cost
  const personProviders = new Map<string, Map<string, Set<string>>>() // person -> month -> provider ids
  const daily = new Map<string, { cost: number; providers: Set<string> }>() // person \0 date
  for (const r of inWindow) {
    if (!r.person_id) continue
    const cost = num(r.total_cost_usd)
    const m = ym(r.date)
    const pm = monthly.get(r.person_id) ?? new Map<string, number>()
    pm.set(m, (pm.get(m) ?? 0) + cost)
    monthly.set(r.person_id, pm)
    const pp = personProviders.get(r.person_id) ?? new Map<string, Set<string>>()
    if (cost !== 0) pp.set(m, (pp.get(m) ?? new Set()).add(r.provider_id))
    personProviders.set(r.person_id, pp)
    if (r.date >= `${last}-01`) {
      const k = `${r.person_id}\u0000${r.date}`
      const d = daily.get(k) ?? { cost: 0, providers: new Set<string>() }
      d.cost += cost
      if (cost !== 0) d.providers.add(r.provider_id)
      daily.set(k, d)
    }
  }

  // -- Spikes: last complete month (actual) and current month (projected) ----
  const currentProj = projectByKey(
    inWindow.filter((r) => r.person_id),
    (r) => r.person_id!,
    monthRange(current),
    ctx
  )
  for (const [personId, pm] of monthly) {
    const checks: { month: string; amount: number; previous: number; projected: boolean }[] = [
      { month: last, amount: pm.get(last) ?? 0, previous: pm.get(beforeLast) ?? 0, projected: false },
      { month: current, amount: currentProj.get(personId)?.projected ?? round2(pm.get(current) ?? 0), previous: pm.get(last) ?? 0, projected: true },
    ]
    for (const c of checks) {
      if (!isSpike(c.amount, c.previous)) continue
      const ratio = c.previous > 0 ? Math.round((c.amount / c.previous) * 10) / 10 : null
      const provs = personProviders.get(personId)?.get(c.month) ?? new Set<string>()
      candidates.push({
        ...base("person_spike", personId, c.month),
        amount: round2(c.amount),
        projected: c.projected,
        previousAmount: round2(c.previous),
        ratio,
        label: personLabel(personId),
        detail: [provs.size ? providerList(provs) : null, c.projected ? `actual so far ${fmt(pm.get(c.month) ?? 0)}` : null].filter(Boolean).join(" · "),
        assign: personAssign(personId),
      })
    }
  }

  // -- Person-days -----------------------------------------------------------
  for (const [k, d] of daily) {
    if (!(d.cost > REVIEW_THRESHOLDS.personDayMinUsd)) continue
    const [personId, date] = k.split("\u0000")
    candidates.push({
      ...base("person_day", personId, date),
      amount: round2(d.cost),
      projected: false,
      previousAmount: null,
      ratio: null,
      label: personLabel(personId),
      detail: providerList(d.providers),
      assign: personAssign(personId),
    })
  }

  // -- Newly unassigned spend ------------------------------------------------
  type Group = { first: string | null; costByDate: Map<string, number>; providers: Set<string>; label: string; assign: AssignTarget | null }
  const groups = new Map<string, Group>()
  for (const r of inWindow) {
    if (r.team_id) continue
    const cost = num(r.total_cost_usd)
    let key: string
    let label: string
    let assign: AssignTarget | null = null
    const pid = effectiveProjectId(r)
    if (r.person_id) {
      key = `person:${r.person_id}`
      label = personLabel(r.person_id)
      assign = personAssign(r.person_id)
    } else if (r.org_api_key_id) {
      const k = keys.get(r.org_api_key_id)
      key = `api_key:${r.org_api_key_id}`
      label = k ? k.name || k.external_key_id : r.org_api_key_id
      assign = k ? { kind: "api_key", provider_id: k.provider_id, external_key_id: k.external_key_id, ...(k.name ? { name: k.name } : {}) } : null
    } else if (pid) {
      const p = projects.get(`${r.provider_id}\u0000${pid}`)
      key = `project:${r.provider_id}:${pid}`
      label = p?.name || pid
      assign = { kind: "project", provider_id: r.provider_id, external_project_id: pid, ...(p?.name ? { name: p.name } : {}) }
    } else {
      key = `provider:${r.provider_id}`
      label = `${providerName.get(r.provider_id) ?? r.provider_id} (no person, key or project)`
    }
    const g = groups.get(key) ?? { first: null, costByDate: new Map<string, number>(), providers: new Set<string>(), label, assign }
    g.costByDate.set(r.date, (g.costByDate.get(r.date) ?? 0) + cost)
    if (cost !== 0) {
      g.providers.add(r.provider_id)
      if (!g.first || r.date < g.first) g.first = r.date
    }
    groups.set(key, g)
  }
  for (const [key, g] of groups) {
    // First seen in the window's first day could be older history: not new.
    if (!g.first || g.first < newSince || g.first <= windowStart) continue
    let amount = 0
    for (const [d, c] of g.costByDate) if (d >= g.first) amount += c
    if (!(round2(amount) > 0)) continue
    candidates.push({
      ...base("unassigned_new", key, g.first),
      amount: round2(amount),
      projected: false,
      previousAmount: null,
      ratio: null,
      label: g.label,
      detail: `${providerList(g.providers)} · first seen ${g.first}`,
      assign: g.assign,
    })
  }

  // -- Newly active keys (provider creation date only) -----------------------
  const keySpend = new Map<string, Map<string, number>>()
  for (const r of inWindow) {
    if (!r.org_api_key_id) continue
    const m = keySpend.get(r.org_api_key_id) ?? new Map<string, number>()
    m.set(r.date, (m.get(r.date) ?? 0) + num(r.total_cost_usd))
    keySpend.set(r.org_api_key_id, m)
  }
  for (const k of org.apiKeys) {
    const t = k.provider_created_at ? Date.parse(k.provider_created_at) : NaN
    if (!Number.isFinite(t)) continue
    const created = new Date(t).toISOString().slice(0, 10)
    if (created < newSince || created > today) continue
    let amount = 0
    for (const [d, c] of keySpend.get(k.id) ?? []) if (d >= created) amount += c
    if (!(round2(amount) > 0)) continue
    const owner = k.owner_person_id ? personLabel(k.owner_person_id) : "no owner"
    candidates.push({
      ...base("key_new", k.id, created),
      amount: round2(amount),
      projected: false,
      previousAmount: null,
      ratio: null,
      label: k.name || k.external_key_id,
      detail: `${providerName.get(k.provider_id) ?? k.provider_id} · ${owner} · created ${created}`,
      assign: k.team_id ? null : { kind: "api_key", provider_id: k.provider_id, external_key_id: k.external_key_id, ...(k.name ? { name: k.name } : {}) },
    })
  }

  // -- Decisions -------------------------------------------------------------
  const decided = new Map(decisions.map((d) => [reviewItemId(d.kind, d.subject, d.period), d]))
  let hiddenCount = 0
  const items: ReviewItem[] = []
  for (const it of candidates) {
    const d = decided.get(it.id)
    if (isSuppressed(it.amount, d)) {
      hiddenCount++
      continue
    }
    items.push(d ? { ...it, previous: d } : it)
  }
  const order = new Map(REVIEW_KINDS.map((k, i) => [k, i]))
  items.sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || b.amount - a.amount || a.label.localeCompare(b.label) || a.period.localeCompare(b.period))

  return { today, windowStart, months: { last, current }, thresholds: REVIEW_THRESHOLDS, items, hiddenCount }
}

const fmt = (n: number) => `$${round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
