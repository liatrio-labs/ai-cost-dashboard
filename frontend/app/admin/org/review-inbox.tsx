"use client"

/**
 * "Needs review" tab of /admin/org (issue #44): person spikes, person-days
 * over $300, newly unassigned spend and newly active keys, each with
 * Acknowledge or Assign (the existing /unassigned/assign flow) and an
 * optional note. Without migration 018 the items still list, Acknowledge is
 * hidden and a notice says why.
 */

import { formatMonthLong } from "@/lib/dashboard-types"
import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Check, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import type { ReviewInboxResponse } from "@/lib/org/admin/review"
import { REVIEW_KINDS, type ReviewItem, type ReviewKind } from "@/lib/org/review-inbox"
import { TeamSelect, usd, type Mutate, type Org } from "./shared"

const API = "/api/admin/org"

const KIND_TITLE: Record<ReviewKind, string> = {
  budget_over: "Projected over budget",
  person_spike: "Person spikes",
  person_day: "Person-days",
  unassigned_new: "Newly unassigned spend",
  key_new: "Newly active keys",
}

function kindHelp(kind: ReviewKind, t: ReviewInboxResponse["thresholds"]): string {
  if (kind === "budget_over") return "People, teams and projects whose current month, projected to its end, is over their monthly budget (Budgets tab)."
  if (kind === "person_spike") return `Month spend over ${t.spikeRatio}x the previous month and over ${usd(t.spikeMinUsd)}. The current month is projected.`
  if (kind === "person_day") return `One person's spend on one day over ${usd(t.personDayMinUsd)}.`
  if (kind === "unassigned_new") return `Spend with no team whose person, key or project was first seen in the last ${t.newDays} days.`
  return `Keys the provider created in the last ${t.newDays} days that have spend. Only keys with a stored provider creation date.`
}

/** Never rejects: a network failure comes back as { ok: false, status: 0 } with an error message. */
async function send(path: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: { error?: string } & Record<string, unknown> }> {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: { error: `Network error${e instanceof Error && e.message ? `: ${e.message}` : ""}` } }
  }
}

const periodLabel = (it: ReviewItem) =>
  it.kind === "person_spike" || it.kind === "budget_over" ? it.period : it.kind === "unassigned_new" ? `since ${it.period}` : it.kind === "key_new" ? `created ${it.period}` : it.period

export function ReviewTab({ org, mutate, reloadKey }: { org: Org; mutate: Mutate; reloadKey: number }) {
  const [inbox, setInbox] = useState<ReviewInboxResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let live = true
    send("/review", "GET").then((res) => {
      if (!live) return
      if (res.ok) {
        setInbox(res.data as unknown as ReviewInboxResponse)
        setError(null)
      } else setError(res.data.error || `Failed to load (${res.status})`)
    })
    return () => {
      live = false
    }
  }, [reloadKey, tick])

  const kinds = REVIEW_KINDS.map((k) => ({ kind: k, items: inbox?.items.filter((i) => i.kind === k) ?? [] }))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs review</CardTitle>
        <CardDescription>
          Spend worth a look, computed live from the attributed rollup. Acknowledged and assigned items stay hidden unless their amount grows more than{" "}
          {inbox ? Math.round((inbox.thresholds.regrowthFactor - 1) * 100) : 25}%.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <p className="flex items-center gap-1 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </p>
        )}
        {!inbox && !error && <Loader2 className="h-4 w-4 animate-spin" />}
        {inbox && (
          <>
            {inbox.notice && (
              <p role="status" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="migration-018-notice">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {inbox.notice}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {inbox.items.length} item(s) · {inbox.hiddenCount} hidden by an earlier decision · months {formatMonthLong(inbox.months.last)} (actual) and {formatMonthLong(inbox.months.current)} (projected)
            </p>
            {kinds.map(({ kind, items }) => (
              <section key={kind} className="space-y-2" aria-label={KIND_TITLE[kind]}>
                <div>
                  <h3 className="font-medium">
                    {KIND_TITLE[kind]} ({items.length})
                  </h3>
                  <p className="text-xs text-muted-foreground">{kindHelp(kind, inbox.thresholds)}</p>
                </div>
                {!items.length ? (
                  <p className="text-sm text-muted-foreground">Nothing to review.</p>
                ) : (
                  <div className="divide-y divide-border/50 rounded-md border border-border/50">
                    {items.map((it) => (
                      <ReviewRow key={it.id} item={it} org={org} mutate={mutate} canDecide={inbox.decisions_available} onDone={refresh} />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ReviewRow({
  item,
  org,
  mutate,
  canDecide,
  onDone,
}: {
  item: ReviewItem
  org: Org
  mutate: Mutate
  canDecide: boolean
  onDone: () => void
}) {
  const [note, setNote] = useState("")
  const [assigning, setAssigning] = useState(false)
  const [team, setTeam] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const decide = async (status: "acknowledged" | "assigned") => {
    const res = await send("/review", "POST", { kind: item.kind, subject: item.subject, period: item.period, amount: item.amount, status, note: note || null })
    if (!res.ok) setMsg(res.data.error || `Request failed (${res.status})`)
    return res.ok
  }

  const acknowledge = async () => {
    setBusy(true)
    setMsg(null)
    const ok = await decide("acknowledged")
    setBusy(false)
    if (ok) onDone()
  }

  const assign = async () => {
    if (!item.assign || !team) return
    setBusy(true)
    setMsg(null)
    let ok = false
    try {
      // The existing assign flow; it reloads the org, which refreshes this tab.
      ok = await mutate("/unassigned/assign", "POST", { ...item.assign, team_id: team }, `Assigned ${item.label}`)
      if (ok && canDecide) await decide("assigned")
    } catch (e) {
      setMsg(`Assign failed${e instanceof Error && e.message ? `: ${e.message}` : ""}`)
    } finally {
      setBusy(false)
    }
    if (ok) {
      setAssigning(false)
      onDone()
    }
  }

  return (
    <div className="space-y-2 px-3 py-2" data-testid="review-item">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium">{item.label}</span>
          <Badge variant="outline" className="ml-2">
            {periodLabel(item)}
          </Badge>
          {item.kind === "budget_over" ? (
            <Badge variant="destructive" className="ml-1" title="Current month projected to its end (issue #39) is over the monthly budget">
              Projected over budget
            </Badge>
          ) : (
            item.projected && (
              <Badge variant="secondary" className="ml-1" title="Current month projected to its end (issue #39)">
                projected
              </Badge>
            )
          )}
          <span className="ml-2 text-xs text-muted-foreground">
            {item.kind === "person_spike" &&
              (item.ratio !== null ? `${item.ratio}x vs ${usd(item.previousAmount ?? 0)} the month before` : "no spend the month before")}
            {item.kind === "person_spike" && item.detail ? " · " : ""}
            {item.detail}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-28 text-right font-mono text-sm">{usd(item.amount)}</span>
          <Input className="h-8 w-48" aria-label={`Note for ${item.label}`} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          {canDecide && (
            <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={acknowledge}>
              <Check className="h-4 w-4" />
              Acknowledge
            </Button>
          )}
          {item.assign && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAssigning(!assigning)}>
              Assign
            </Button>
          )}
        </div>
      </div>
      {item.previous && (
        <p className="text-xs text-muted-foreground">
          Came back: {item.previous.status} at {usd(Number(item.previous.amount))}
          {item.previous.acknowledged_by ? ` by ${item.previous.acknowledged_by}` : ""}
          {item.previous.note ? `: “${item.previous.note}”` : ""}
        </p>
      )}
      {assigning && item.assign && (
        <div className="flex flex-wrap items-center gap-2 pl-2">
          <span className="text-sm text-muted-foreground">
            Assign {item.assign.kind === "person" ? "person" : item.assign.kind === "api_key" ? "API key" : "project"} to
          </span>
          <TeamSelect org={org} value={team} noneLabel="Choose team…" ariaLabel={`Team for ${item.label}`} onChange={setTeam} />
          <Button size="sm" disabled={!team || busy} onClick={assign}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Assign
          </Button>
        </div>
      )}
      {msg && (
        <p className="flex items-center gap-1 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {msg}
        </p>
      )}
    </div>
  )
}
