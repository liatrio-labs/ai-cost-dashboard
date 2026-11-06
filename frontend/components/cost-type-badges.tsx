"use client"

/**
 * Issue #88: Cursor amounts are three distinct cost types. The Tools row's
 * total is seats + calendar-month on-demand; billing-cycle on-demand is a
 * different window (Cursor's own cycle, from the saved /teams/spend snapshot)
 * and is only shown for reconciliation, never added in.
 */

import { Badge } from "@/components/ui/badge"
import { formatCurrency, type CursorCostTypes } from "@/lib/dashboard-types"
import type { CursorCycleView } from "@/lib/cursor-spend"
import type { ScopedCursorCycleView } from "@/lib/cursor-cycle-scope"

type AnyCycleView = CursorCycleView | ScopedCursorCycleView

export const COST_TYPE_LABEL = {
  seats: "Seats",
  calendar: "Calendar on-demand",
  cycle: "Billing-cycle on-demand",
} as const

const utcDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

/** The saved current cycle's dates and on-demand total, or null when there's no snapshot. */
export function cycleReconciliation(view: AnyCycleView | null | undefined): { label: string; total: number } | null {
  if (!view || !view.available || !view.current) return null
  const c = view.current
  // #84's scoped view: a person/team filter narrows to that selection's members.
  const filtered = "scope" in view && view.scope.kind === "filtered"
  const cents = filtered && "selectionSpendCents" in c ? c.selectionSpendCents : c.teamSpendCents
  if (cents === null || cents === undefined) return null
  return { label: `${utcDate(c.cycleStart)} to ${utcDate(c.cycleEnd)}${c.cycleEndEstimated ? " (end estimated)" : ""}`, total: cents / 100 }
}

/** One-line explanation of what the Cursor total is and is not. */
export function cursorReconciliationText(types: CursorCostTypes | undefined, view: AnyCycleView | null | undefined): string {
  const parts: string[] = []
  if (types) {
    parts.push(
      `This calendar-period total is ${formatCurrency(types.seats)} seats + ${formatCurrency(types.calendarOnDemand)} calendar on-demand usage.`
    )
  } else {
    parts.push("This calendar-period total is on-demand usage only (no seat fees recorded).")
  }
  const cyc = cycleReconciliation(view)
  if (cyc) {
    parts.push(
      `Cursor's billing cycle ${cyc.label} shows ${formatCurrency(cyc.total)} on-demand: a different window, not added to this total.`
    )
  }
  parts.push("Usage included in the Business plan is not billed and counts $0.")
  return parts.join(" ")
}

/** Cost-type badges under the Cursor total, with the seat composition and a reconciliation tooltip. */
export function CursorCostTypeBadges({
  total,
  types,
  cycle,
}: {
  /** The Cursor row total (used as calendar on-demand when no cost types were computed). */
  total: number
  types?: CursorCostTypes
  cycle?: AnyCycleView | null
}) {
  const title = cursorReconciliationText(types, cycle)
  const cyc = cycleReconciliation(cycle)
  return (
    <span className="mt-1 flex flex-col gap-1 font-sans" data-testid="cursor-cost-types" title={title}>
      <span className="flex flex-wrap gap-1">
        {types && types.seats !== 0 && (
          <Badge variant="outline" data-testid="cost-type-seats">
            {COST_TYPE_LABEL.seats} {formatCurrency(types.seats)}
          </Badge>
        )}
        <Badge variant="outline" data-testid="cost-type-calendar">
          {COST_TYPE_LABEL.calendar} {formatCurrency(types ? types.calendarOnDemand : total)}
        </Badge>
      </span>
      {types?.seatComposition && (
        <span className="text-xs text-muted-foreground" data-testid="cursor-seat-composition">
          Seats: {types.seatComposition.text}
        </span>
      )}
      {cyc && (
        <span className="text-xs text-muted-foreground" data-testid="cost-type-cycle">
          {COST_TYPE_LABEL.cycle} ({cyc.label}): {formatCurrency(cyc.total)}, separate window, not included above
        </span>
      )}
    </span>
  )
}
