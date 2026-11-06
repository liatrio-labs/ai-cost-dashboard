/**
 * Issue #84: scope the Cursor billing-cycle on-demand view (issue #76,
 * migration 025) to the dashboard's org filters, and judge its freshness.
 *
 * Source: cursor_member_cycle_spend.spend_cents (Cursor spendCents) for the
 * latest cursor_spend_cycles row, with that row's cycle dates and
 * captured_at. Nothing else: no cost_records, no seat rows, no
 * overallSpendCents. The selection total is the sum of the matching members'
 * spend_cents and is never added to calendar-month event or seat totals.
 *
 * Members are matched to people exactly the way a Cursor usage event is
 * attributed (lib/org/attribution.ts resolveAttribution with the member's
 * email as person_email on the Cursor provider): people.email
 * case-insensitively, else a Cursor person_identities row keyed by that
 * email. Display names are never compared, so "Jacob LeCoq" in the org and
 * "Jacob Lecoq" in Cursor still match on email, and two people who share a
 * display name never borrow each other's spend. Team and department follow
 * from the resolved person (Cursor rows carry no API key or project), so a
 * team / department filter sees the same members its Cursor events do.
 *
 * Filters that can't apply to a per-member snapshot (an API key, a project,
 * the Cursor automation line, a non-Cursor provider) return a
 * "not_applicable" scope with a reason instead of an empty or zero total.
 */

import { AUTOMATION_FILTER, hasOrgFilters, matchesFilters, type DashboardFilters } from "@/lib/dashboard-filters"
import { buildOrgIndex, resolveAttribution } from "@/lib/org/attribution"
import type { OrgData } from "@/lib/org/types"
import type { CursorCycleMember, CursorCycleView } from "@/lib/cursor-spend"

export const CURSOR_PROVIDER_SLUG = "cursor"

/** Filters the cycle view is scoped by (the period is irrelevant: a cycle has its own dates). */
export const CYCLE_FILTER_KEYS = ["department", "team", "person", "key", "project", "provider"] as const

export type CursorCycleScope =
  | { kind: "team" }
  | { kind: "filtered"; matchedMembers: number }
  | { kind: "not_applicable"; reason: string }

export type ScopedCursorCycleView =
  | { available: false; notice: string }
  | {
      available: true
      scope: CursorCycleScope
      /**
       * Current cycle with members narrowed to the scope. selectionSpendCents
       * is the sum of those members' spendCents (null when none of them has a
       * value); teamSpendCents stays the whole team's total.
       */
      current:
        | (Extract<CursorCycleView, { available: true }>["current"] & {
            selectionSpendCents: number | null
          })
        | null
      /** Earlier cycles' team totals; only for the unscoped (team) view. */
      previous: Extract<CursorCycleView, { available: true }>["previous"]
    }

export const NOT_APPLICABLE = {
  provider: "This card covers Cursor only. Clear the provider filter or pick Cursor to see billing-cycle on-demand.",
  key: "Cursor billing-cycle on-demand is per member, not per API key, so it can't be narrowed to an API key.",
  project: "Cursor billing-cycle on-demand is per member, not per project, so it can't be narrowed to a project.",
  automation:
    "The Cursor automation line has no member, and billing-cycle on-demand is reported per member, so there is nothing to show for it.",
} as const

/** Sum of members' spendCents; null when no member has a value (never a silent $0). */
export function sumSpendCents(members: Pick<CursorCycleMember, "spendCents">[]): number | null {
  let total: number | null = null
  for (const m of members) if (m.spendCents !== null) total = (total ?? 0) + m.spendCents
  return total
}

/** Why the filters can't scope a per-member cycle view, or null when they can. */
export function cycleScopeBlocker(filters: DashboardFilters): string | null {
  if (filters.provider && filters.provider !== CURSOR_PROVIDER_SLUG) return NOT_APPLICABLE.provider
  if (filters.key) return NOT_APPLICABLE.key
  if (filters.project) return NOT_APPLICABLE.project
  if (filters.department === AUTOMATION_FILTER || filters.team === AUTOMATION_FILTER || filters.person === AUTOMATION_FILTER) {
    return NOT_APPLICABLE.automation
  }
  return null
}

/** Do the filters narrow the cycle view to some members (vs the whole team)? */
export function isScopedCycleRequest(filters: DashboardFilters): boolean {
  return hasOrgFilters(filters)
}

/**
 * Scope a cycle view to the filters. `org` and `cursorProviderId` are needed
 * only when the filters carry an org filter; pass them as loaded for the
 * dashboard (org tables plus Cursor person_identities).
 */
export function scopeCursorCycleView(
  view: CursorCycleView,
  filters: DashboardFilters,
  ctx: { org: OrgData | null; cursorProviderId: string | null }
): ScopedCursorCycleView {
  if (!view.available) return view
  const blocker = cycleScopeBlocker(filters)
  if (blocker) {
    return { available: true, scope: { kind: "not_applicable", reason: blocker }, current: null, previous: [] }
  }
  const cur = view.current
  if (!isScopedCycleRequest(filters)) {
    return {
      available: true,
      scope: { kind: "team" },
      current: cur ? { ...cur, selectionSpendCents: sumSpendCents(cur.members) } : null,
      previous: view.previous,
    }
  }
  if (!cur) return { available: true, scope: { kind: "filtered", matchedMembers: 0 }, current: null, previous: [] }
  const members = membersMatchingFilters(cur.members, filters, ctx)
  return {
    available: true,
    scope: { kind: "filtered", matchedMembers: members.length },
    current: { ...cur, members, selectionSpendCents: sumSpendCents(members) },
    // Earlier cycles are stored per member too, but the view only loads the
    // current cycle's members; a team total there would mislead a filtered view.
    previous: [],
  }
}

/** Members whose email resolves (like a Cursor usage event) to a row passing the org filters. */
export function membersMatchingFilters(
  members: CursorCycleMember[],
  filters: DashboardFilters,
  ctx: { org: OrgData | null; cursorProviderId: string | null }
): CursorCycleMember[] {
  // Without the Cursor provider row there are no Cursor identities to use;
  // a placeholder id still lets people.email match.
  const providerId = ctx.cursorProviderId ?? "cursor"
  const index = buildOrgIndex(ctx.org ?? { departments: [], teams: [], people: [], identities: [], apiKeys: [] })
  const orgOnly: DashboardFilters = { ...filters }
  delete orgOnly.provider
  return members.filter((m) => {
    const resolved = resolveAttribution(
      { provider_id: providerId, metadata: { attribution: { person_email: m.email, granularity: "person" } } },
      index
    )
    return matchesFilters({ ...resolved, provider_id: providerId, granularity: "person" }, orgOnly)
  })
}

/** Snapshots run hourly (and after each Cursor pull); older than this is stale. */
export const CYCLE_STALE_AFTER_MS = 6 * 60 * 60 * 1000

export type CycleFreshness =
  | { status: "fresh" }
  | { status: "stale"; reason: "no_snapshot_time" | "old_snapshot" | "cycle_ended" }

/** Is the current cycle's last snapshot recent, and is the cycle still running? */
export function cycleFreshness(
  current: { capturedAt: string | null; cycleEnd: string },
  now: Date = new Date()
): CycleFreshness {
  if (!current.capturedAt || Number.isNaN(Date.parse(current.capturedAt))) return { status: "stale", reason: "no_snapshot_time" }
  if (now.getTime() >= Date.parse(current.cycleEnd)) return { status: "stale", reason: "cycle_ended" }
  if (now.getTime() - Date.parse(current.capturedAt) > CYCLE_STALE_AFTER_MS) return { status: "stale", reason: "old_snapshot" }
  return { status: "fresh" }
}

/** Query string (no "?") for /api/dashboard/cursor-cycle: the filters only, in a stable order. */
export function cycleQueryString(filters: DashboardFilters): string {
  const sp = new URLSearchParams()
  for (const k of CYCLE_FILTER_KEYS) if (filters[k]) sp.set(k, filters[k]!)
  return sp.toString()
}
