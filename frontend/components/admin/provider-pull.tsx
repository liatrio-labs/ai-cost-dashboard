"use client"

/**
 * "Pull data from providers" card on /admin (issue #28): the providers with an
 * automated collector, an optional start/end date range (validated server-side
 * by lib/collectors/date-range, <= 31 days) next to the backfill toggle, and
 * "Sync keys now" for AI Gateway keys.
 *
 * A range applies to the providers that support one (RANGE_PROVIDERS); the
 * rest keep the trailing window / backfill toggle.
 */

import { useState } from "react"
import { AlertCircle, CheckCircle2, Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { MAX_RANGE_DAYS, supportsRange } from "@/lib/collectors/range-providers"
import { KeySyncButton, formatSyncSummary, type GatewaySyncCounts } from "./gateway-key-sync"

// Providers that have an automated collector (the "Pull" list). Manual/seat
// tools added via the admin form are NOT pullable and don't appear here.
export const PULL_PROVIDERS: { id: string; name: string }[] = [
  { id: "anthropic", name: "Anthropic API (platform.claude.com)" },
  { id: "claude-ai", name: "Claude.ai (Enterprise Analytics)" },
  { id: "openai", name: "OpenAI API (platform.openai.com)" },
  { id: "cursor", name: "Cursor (Admin API)" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway" },
]

export interface PullOptions {
  backfill: boolean
  startDate: string
  endDate: string
}

/** The POST /api/admin/collect body for one provider. */
export function pullRequestBody(provider: string, o: PullOptions): Record<string, unknown> {
  if (o.startDate && o.endDate && supportsRange(provider)) {
    return { provider, start_date: o.startDate, end_date: o.endDate }
  }
  return { provider, backfill: o.backfill }
}

/** Quick client-side check so an obviously bad range doesn't fan out to every provider. The server re-validates. */
export function rangeProblem(startDate: string, endDate: string): string | null {
  if (!startDate && !endDate) return null
  if (!startDate || !endDate) return "Set both a start and an end date, or neither."
  const s = Date.parse(`${startDate}T00:00:00Z`)
  const e = Date.parse(`${endDate}T00:00:00Z`)
  if (Number.isNaN(s) || Number.isNaN(e)) return "Dates must be YYYY-MM-DD."
  if (s > e) return "Start must be on or before end."
  const days = Math.round((e - s) / 86_400_000) + 1
  if (days > MAX_RANGE_DAYS) return `Range spans ${days} days; the maximum is ${MAX_RANGE_DAYS}.`
  return null
}

interface PullResult {
  loading?: boolean
  status?: string
  recordsStored?: number
  reason?: string
  error?: string
  range?: { start_date: string; end_date: string; clamped?: boolean }
  keySync?: (GatewaySyncCounts & { status?: string; error?: string; cycle_spend?: { status?: string; reason?: string } }) | null
}

export function ProviderPullCard() {
  const [backfill, setBackfill] = useState(false)
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [results, setResults] = useState<Record<string, PullResult>>({})
  const problem = rangeProblem(startDate, endDate)
  const ranged = !!startDate && !!endDate && !problem

  async function pull(provider: string) {
    if (problem) return
    setResults((r) => ({ ...r, [provider]: { loading: true } }))
    try {
      const res = await fetch("/api/admin/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pullRequestBody(provider, { backfill, startDate, endDate })),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResults((r) => ({ ...r, [provider]: { error: body.error || `HTTP ${res.status}` } }))
        return
      }
      setResults((r) => ({
        ...r,
        [provider]: {
          status: body.status,
          recordsStored: body.records_stored ?? 0,
          reason: body.reason,
          error: body.error,
          range: body.range,
          keySync: body.key_sync ?? null,
        },
      }))
    } catch (e) {
      setResults((r) => ({ ...r, [provider]: { error: (e instanceof Error && e.message) || "Request failed" } }))
    }
  }

  async function pullAll() {
    for (const p of PULL_PROVIDERS) {
      // sequential so the providers aren't hammered all at once
      await pull(p.id)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pull data from providers</CardTitle>
        <CardDescription>
          Trigger collection on demand. Daily collection also runs automatically. Claude.ai re-pulls the last 31 days so totals can catch up with
          the Usage admin page. Enable backfill to pull the last 90 days, or set a date range (up to {MAX_RANGE_DAYS} days) to re-pull exactly those
          days for Anthropic, Claude.ai, OpenAI and Vercel AI Gateway. Cursor ignores the range and uses the backfill toggle.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/50 p-3">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} className="h-4 w-4 accent-primary" />
              Backfill last 90 days
            </label>
            <label className="flex items-center gap-2 text-sm">
              From
              <Input type="date" aria-label="Start date" className="h-8 w-40" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              to
              <Input type="date" aria-label="End date" className="h-8 w-40" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
            {(startDate || endDate) && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline hover:text-foreground"
                onClick={() => {
                  setStartDate("")
                  setEndDate("")
                }}
              >
                Clear range
              </button>
            )}
          </div>
          <Button onClick={pullAll} className="gap-2" disabled={!!problem}>
            <Download className="h-4 w-4" />
            Pull all
          </Button>
        </div>
        {problem && (
          <p className="flex items-center gap-1 text-xs text-destructive" role="alert">
            <AlertCircle className="h-3 w-3" />
            {problem}
          </p>
        )}

        <div className="divide-y divide-border/50">
          {PULL_PROVIDERS.map((p) => {
            const r = results[p.id]
            const usesRange = ranged && supportsRange(p.id)
            return (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-4 py-3" data-testid={`pull-${p.id}`}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {p.name}
                    {usesRange && <span className="ml-2 text-xs font-normal text-muted-foreground">range {startDate} to {endDate}</span>}
                  </p>
                  {r && !r.loading && <PullStatus r={r} />}
                </div>
                <div className="flex items-center gap-2">
                  {(p.id === "vercel-ai-gateway" || p.id === "anthropic" || p.id === "openai") && <KeySyncButton providers={[p.id]} />}
                  <Button variant="outline" size="sm" onClick={() => pull(p.id)} disabled={r?.loading || !!problem} className="gap-2" aria-label={`Pull ${p.name}`}>
                    {r?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    Pull
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function PullStatus({ r }: { r: PullResult }) {
  const line = "mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"
  if (r.error || r.status === "error") {
    return (
      <p className={line}>
        <AlertCircle className="h-3 w-3 text-destructive" />
        <span className="text-destructive">{r.error || "Error"}</span>
      </p>
    )
  }
  if (r.status === "skipped") {
    return (
      <p className={line}>
        <AlertCircle className="h-3 w-3 text-amber-500" />
        {r.reason || "Skipped (no API key set)"}
      </p>
    )
  }
  return (
    <>
      <p className={line}>
        <CheckCircle2 className="h-3 w-3 text-primary" />
        Stored {r.recordsStored} record{r.recordsStored === 1 ? "" : "s"}
        {r.range && ` for ${r.range.start_date} to ${r.range.end_date}${r.range.clamped ? " (start moved to the earliest available day)" : ""}`}
      </p>
      {r.keySync?.cycle_spend ? (
        // Issue #76: Cursor's billing-cycle snapshot, not a key sync.
        <p className={line}>
          Billing-cycle snapshot: {r.keySync.cycle_spend.status}
          {r.keySync.cycle_spend.reason ? ` (${r.keySync.cycle_spend.reason})` : ""}
        </p>
      ) : r.keySync && (
        <p className={line}>
          {r.keySync.status === "error" ? (
            <span className="text-destructive">Key sync failed: {r.keySync.error}</span>
          ) : (
            `Key sync: ${formatSyncSummary(r.keySync)}`
          )}
        </p>
      )}
    </>
  )
}
