"use client"

/**
 * Cursor billing-cycle on-demand card (issue #76). Presentational; the view
 * comes from GET /api/dashboard/cursor-cycle (lib/cursor-spend.ts).
 *
 * Billing-cycle figures are labelled as such and kept apart from the
 * calendar-month totals elsewhere on the dashboard: a Cursor cycle runs from
 * subscriptionCycleStart (e.g. the 19th) to the next reset, not month to month.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCurrency } from "@/lib/dashboard-types"
import type { CursorCycleMember, CursorCycleView } from "@/lib/cursor-spend"

/** "Oct 19, 2026" in UTC (cycle boundaries are UTC instants). */
export function formatCycleDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

function formatCapturedAt(iso: string | null): string {
  if (!iso) return "unknown"
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  })
}

const dollars = (cents: number | null) => (cents === null ? "–" : formatCurrency(cents / 100))

/** The limit that applies, and where it comes from. */
export function describeLimit(m: CursorCycleMember): { limit: string; detail: string | null } {
  const eff = m.effectivePerUserLimitDollars
  const parts: string[] = []
  if (m.hardLimitOverrideDollars !== null && m.hardLimitOverrideDollars > 0) {
    parts.push(`override ${formatCurrency(m.hardLimitOverrideDollars)}`)
  }
  if (m.monthlyLimitDollars !== null) parts.push(`team default ${formatCurrency(m.monthlyLimitDollars)}`)
  return { limit: eff === null ? "No limit" : formatCurrency(eff), detail: parts.length ? parts.join(", ") : null }
}

function usedOfLimit(m: CursorCycleMember): string | null {
  if (m.effectivePerUserLimitDollars === null || m.effectivePerUserLimitDollars <= 0 || m.spendCents === null) return null
  return `${Math.round((m.spendCents / 100 / m.effectivePerUserLimitDollars) * 100)}%`
}

export function CursorCycleSpendCard({ view }: { view: CursorCycleView }) {
  if (!view.available) {
    return (
      <Card data-testid="cursor-cycle-notice" className="border-border/50 bg-card/50">
        <CardHeader>
          <CardTitle className="text-base">Cursor billing cycle</CardTitle>
          <CardDescription>{view.notice}</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  const cur = view.current
  if (!cur) {
    return (
      <Card data-testid="cursor-cycle-empty" className="border-border/50 bg-card/50">
        <CardHeader>
          <CardTitle className="text-base">Cursor billing cycle</CardTitle>
          <CardDescription>No /teams/spend snapshot yet. The first one is taken on the next hourly snapshot or Cursor pull.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card data-testid="cursor-cycle" className="border-border/50 bg-card/50">
      <CardHeader>
        <CardTitle className="text-base">Cursor on-demand, current billing cycle</CardTitle>
        <CardDescription>
          Billing cycle <span data-testid="cursor-cycle-dates">{formatCycleDate(cur.cycleStart)} to {formatCycleDate(cur.cycleEnd)}</span>
          {cur.cycleEndEstimated ? " (next reset estimated as one month after the start)" : ""}. Team on-demand is the sum of each
          member&apos;s Cursor spendCents (usage beyond the included pool) from /teams/spend. This is a billing-cycle total, not the
          calendar-month total shown elsewhere on the dashboard. Last snapshot {formatCapturedAt(cur.capturedAt)}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <div className="text-xs text-muted-foreground">Team on-demand this cycle</div>
            <div data-testid="cursor-cycle-team-total" className="font-mono text-2xl font-semibold">
              {dollars(cur.teamSpendCents)}
            </div>
          </div>
          {cur.teamOverallSpendCents !== null && (
            <div title="overallSpendCents: included usage plus on-demand. Not billed on-demand.">
              <div className="text-xs text-muted-foreground">Overall usage value (incl. included, not billed on-demand)</div>
              <div data-testid="cursor-cycle-team-overall" className="font-mono text-sm text-muted-foreground">
                {dollars(cur.teamOverallSpendCents)}
              </div>
            </div>
          )}
          <div>
            <div className="text-xs text-muted-foreground">Members</div>
            <div className="font-mono text-sm">{cur.memberCount}</div>
          </div>
        </div>

        <div className="max-h-96 overflow-auto rounded-md border border-border/50">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead className="text-right">On-demand (cycle)</TableHead>
                <TableHead className="text-right">Limit</TableHead>
                <TableHead className="hidden text-right md:table-cell">Used</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Overall incl. included</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cur.members.map((m) => {
                const { limit, detail } = describeLimit(m)
                return (
                  <TableRow key={m.email} data-testid="cursor-cycle-member" data-email={m.email}>
                    <TableCell>
                      <div className="text-sm">{m.name ?? m.email}</div>
                      {m.name && <div className="text-xs text-muted-foreground">{m.email}</div>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{dollars(m.spendCents)}</TableCell>
                    <TableCell className="text-right text-sm">
                      <div className="font-mono">{limit}</div>
                      {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
                    </TableCell>
                    <TableCell className="hidden text-right font-mono text-sm text-muted-foreground md:table-cell">
                      {usedOfLimit(m) ?? "–"}
                    </TableCell>
                    <TableCell className="hidden text-right font-mono text-sm text-muted-foreground lg:table-cell">
                      {dollars(m.overallSpendCents)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        {view.previous.length > 0 && (
          <div data-testid="cursor-cycle-previous">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Previous billing cycles (final snapshot, on-demand)</div>
            <ul className="space-y-1 text-sm">
              {view.previous.map((c) => (
                <li key={c.cycleStart} className="flex flex-wrap justify-between gap-2" data-testid="cursor-cycle-previous-row">
                  <span>
                    {formatCycleDate(c.cycleStart)} to {formatCycleDate(c.cycleEnd)}
                    <span className="text-xs text-muted-foreground"> · snapshot {formatCapturedAt(c.capturedAt)}</span>
                  </span>
                  <span className="font-mono">{dollars(c.teamSpendCents)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
