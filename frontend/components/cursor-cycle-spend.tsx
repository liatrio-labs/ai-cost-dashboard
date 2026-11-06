"use client"

/**
 * Cursor billing-cycle on-demand (issue #76; Tools / person views, issue #84).
 * The view comes from GET /api/dashboard/cursor-cycle (lib/cursor-spend.ts,
 * scoped by lib/cursor-cycle-scope.ts).
 *
 * Three different Cursor measures exist and are kept apart:
 *   (a) this card: billing-cycle on-demand, the sum of members' spendCents
 *       snapshots (cursor_member_cycle_spend.spend_cents) for the cycle's own
 *       dates (e.g. the 19th to the 19th);
 *   (b) calendar-month usage from Cursor usage events (cost_records), shown
 *       in the Cursor tool row and the by-product card;
 *   (c) seat subscription fees (synthetic "cursor seats" rows, 20th-to-20th
 *       seat cycle), shown as the Seats slice.
 * (a) is never added to (b) or (c): a cycle snapshot is cumulative and would
 * double-count.
 *
 * CursorCycleOnDemand renders every load state explicitly (loading, error with
 * retry, migration missing, no snapshot, not applicable, no matching member,
 * stale snapshot) so the card never silently disappears or shows a made-up $0.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { formatCurrency } from "@/lib/dashboard-types"
import type { CursorCycleMember, CursorCycleView } from "@/lib/cursor-spend"
import {
  cycleFreshness,
  sumSpendCents,
  type CycleFreshness,
  type ScopedCursorCycleView,
} from "@/lib/cursor-cycle-scope"

/** "Oct 19, 2026" in UTC (cycle boundaries are UTC instants). */
export function formatCycleDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

/** "Oct 19" in UTC, for the card title. */
export function formatCycleDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

export function formatCapturedAt(iso: string | null): string {
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

/** Where the card is shown; changes wording only. */
export type CycleCardContext = "dashboard" | "tools" | "person"

const STALE_TEXT: Record<Exclude<CycleFreshness, { status: "fresh" }>["reason"], string> = {
  no_snapshot_time: "The last snapshot time is unknown, so this figure may be out of date.",
  old_snapshot: "The last snapshot is more than 6 hours old (snapshots run hourly), so this figure may be out of date.",
  cycle_ended:
    "This billing cycle has reset and no snapshot of the new cycle has been taken yet. The figure is the old cycle's last snapshot.",
}

export const SEPARATION_NOTE =
  "Billing-cycle on-demand from Cursor member spend snapshots (spendCents), for the cycle's own dates. It is a separate measure from the calendar-month Cursor usage from usage events and from seat subscription fees (20th-to-20th seat cycle), and is never added to either: the snapshot is cumulative, so adding it would double-count."

function StateCard({ testId, title, children, alert }: { testId: string; title: string; children: ReactNode; alert?: boolean }) {
  return (
    <Card data-testid={testId} role={alert ? "alert" : undefined} className="border-border/50 bg-card/50">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{children}</CardDescription>
      </CardHeader>
    </Card>
  )
}

/** Treat an unscoped (issue #76) view as the team scope. */
function normalize(view: CursorCycleView | ScopedCursorCycleView): ScopedCursorCycleView {
  if (!view.available || "scope" in view) return view as ScopedCursorCycleView
  return {
    available: true,
    scope: { kind: "team" },
    current: view.current ? { ...view.current, selectionSpendCents: sumSpendCents(view.current.members) } : null,
    previous: view.previous,
  }
}

export function CursorCycleSpendCard({
  view: raw,
  context = "dashboard",
  now,
}: {
  view: CursorCycleView | ScopedCursorCycleView
  context?: CycleCardContext
  now?: Date
}) {
  const view = normalize(raw)
  if (!view.available) {
    return (
      <StateCard testId="cursor-cycle-notice" title="Cursor billing cycle">
        {view.notice}
      </StateCard>
    )
  }
  if (view.scope.kind === "not_applicable") {
    return (
      <StateCard testId="cursor-cycle-not-applicable" title="Cursor on-demand, current billing cycle">
        {view.scope.reason}
      </StateCard>
    )
  }
  const cur = view.current
  if (!cur) {
    return (
      <StateCard testId="cursor-cycle-empty" title="Cursor billing cycle">
        No /teams/spend snapshot yet. The first one is taken on the next hourly snapshot or Cursor pull.
      </StateCard>
    )
  }

  const filtered = view.scope.kind === "filtered"
  const freshness = cycleFreshness(cur, now)
  const single = filtered && cur.members.length === 1 ? cur.members[0] : null
  const totalLabel = !filtered
    ? "Team on-demand this cycle"
    : single
      ? `${single.name ?? single.email} on-demand this cycle`
      : "Selection on-demand this cycle"

  return (
    <Card data-testid="cursor-cycle" data-scope={view.scope.kind} data-context={context} className="border-border/50 bg-card/50">
      <CardHeader>
        <CardTitle className="text-base" data-testid="cursor-cycle-title">
          Cursor on-demand, {formatCycleDay(cur.cycleStart)} to {formatCycleDay(cur.cycleEnd)} billing cycle
        </CardTitle>
        <CardDescription>
          Billing cycle <span data-testid="cursor-cycle-dates">{formatCycleDate(cur.cycleStart)} to {formatCycleDate(cur.cycleEnd)}</span>
          {cur.cycleEndEstimated ? " (next reset estimated as one month after the start)" : ""}. On-demand is the sum of each
          member&apos;s Cursor spendCents (usage beyond the included pool) from /teams/spend. This is a billing-cycle total, not the
          calendar-month total shown elsewhere on the dashboard.{" "}
          <span data-testid="cursor-cycle-captured">Last snapshot {formatCapturedAt(cur.capturedAt)}.</span>
          {filtered && " Members are matched to people by email or linked Cursor identity, never by display name."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {freshness.status === "stale" && (
          <div
            data-testid="cursor-cycle-stale"
            data-reason={freshness.reason}
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Stale: {STALE_TEXT[freshness.reason]}</span>
          </div>
        )}

        {filtered && cur.members.length === 0 ? (
          <p data-testid="cursor-cycle-no-match" className="text-sm text-muted-foreground">
            No member of the current cycle&apos;s Cursor snapshot matches this selection (matched by email or Cursor identity). Either
            Cursor reports no seat for them, or their Cursor email isn&apos;t linked to this person. Team on-demand this cycle is{" "}
            {dollars(cur.teamSpendCents)}.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div>
                <div className="text-xs text-muted-foreground">{totalLabel}</div>
                <div
                  data-testid={filtered ? "cursor-cycle-selection-total" : "cursor-cycle-team-total"}
                  className="font-mono text-2xl font-semibold"
                >
                  {dollars(filtered ? cur.selectionSpendCents : cur.teamSpendCents)}
                </div>
              </div>
              {filtered && (
                <div>
                  <div className="text-xs text-muted-foreground">Team on-demand this cycle</div>
                  <div data-testid="cursor-cycle-team-total" className="font-mono text-sm text-muted-foreground">
                    {dollars(cur.teamSpendCents)}
                  </div>
                </div>
              )}
              {!filtered && cur.teamOverallSpendCents !== null && (
                <div title="overallSpendCents: included usage plus on-demand. Not billed on-demand.">
                  <div className="text-xs text-muted-foreground">Overall usage value (incl. included, not billed on-demand)</div>
                  <div data-testid="cursor-cycle-team-overall" className="font-mono text-sm text-muted-foreground">
                    {dollars(cur.teamOverallSpendCents)}
                  </div>
                </div>
              )}
              <div>
                <div className="text-xs text-muted-foreground">Members</div>
                <div className="font-mono text-sm">{filtered ? cur.members.length : cur.memberCount}</div>
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
          </>
        )}

        <p data-testid="cursor-cycle-separation" className="text-xs text-muted-foreground">
          {SEPARATION_NOTE}
        </p>

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

/** Load state for the cycle card. */
export type CursorCycleLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; view: ScopedCursorCycleView }

/**
 * Fetch GET /api/dashboard/cursor-cycle?<qs> (filters only) and track its
 * state. A failed request becomes { status: "error" } with the server's
 * message, never a hidden card.
 */
export function useCursorCycle(qs: string, enabled = true): { load: CursorCycleLoad; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  // The settled result for one request (filters + attempt); any other key is still loading.
  const key = `${attempt}:${qs}`
  const [settled, setSettled] = useState<{ key: string; load: CursorCycleLoad } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch(`/api/dashboard/cursor-cycle${qs ? `?${qs}` : ""}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error((body && typeof body.error === "string" && body.error) || `Request failed (${r.status})`)
        if (!body || typeof body.available !== "boolean") throw new Error("Unexpected response")
        return body as ScopedCursorCycleView
      })
      .then((view) => !cancelled && setSettled({ key, load: { status: "loaded", view } }))
      .catch(
        (e: unknown) =>
          !cancelled && setSettled({ key, load: { status: "error", message: e instanceof Error ? e.message : String(e) } })
      )
    return () => {
      cancelled = true
    }
  }, [key, qs, enabled])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { load: settled?.key === key ? settled.load : { status: "loading" }, retry }
}

/** The cycle card in every load state (Dashboard, Tools and person views). */
export function CursorCycleOnDemand({
  load,
  onRetry,
  context = "dashboard",
  now,
}: {
  load: CursorCycleLoad
  onRetry?: () => void
  context?: CycleCardContext
  now?: Date
}) {
  if (load.status === "loading") {
    return (
      <Card data-testid="cursor-cycle-loading" aria-busy="true" className="border-border/50 bg-card/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Spinner className="h-4 w-4" />
            Cursor on-demand, current billing cycle
          </CardTitle>
          <CardDescription>Loading the latest billing-cycle snapshot…</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  if (load.status === "error") {
    return (
      <Card data-testid="cursor-cycle-error" role="alert" className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-base">Cursor on-demand, current billing cycle</CardTitle>
          <CardDescription>
            Couldn&apos;t load Cursor billing-cycle on-demand: <span data-testid="cursor-cycle-error-message">{load.message}</span>. Other
            totals on this page are unaffected.
          </CardDescription>
        </CardHeader>
        {onRetry && (
          <CardContent>
            <Button variant="outline" size="sm" className="gap-2" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </CardContent>
        )}
      </Card>
    )
  }
  return <CursorCycleSpendCard view={load.view} context={context} now={now} />
}
