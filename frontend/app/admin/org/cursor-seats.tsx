"use client"

/**
 * Cursor seat types on /admin/org (migration 026): the per-person seat type
 * select on each People row, and a card with the month's seat summary, the
 * admin-editable monthly rates, and the roster CSV backfill. Changes apply
 * from the current month onward; earlier months are never changed.
 */

import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Loader2, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ASSIGNABLE_SEAT_TYPES,
  SEAT_TYPES,
  SEAT_TYPE_LABEL,
  type AssignableSeatType,
  type RosterPlan,
  type SeatType,
} from "@/lib/cursor-seats"
import type { CursorSeatState } from "@/lib/cursor-seats-admin"
import { selectClass, usd, type Org } from "./shared"

const API = "/api/admin/org/cursor-seats"

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

async function call<T>(path: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: (data as { error?: string }).error || `Request failed (${res.status})` }
    return { ok: true, data: data as T }
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : "Request failed" }
  }
}

export interface CursorSeats {
  state: CursorSeatState | null
  error: string | null
  /** Set one person's seat type from the current month; resolves true on success. */
  assign: (personId: string, type: AssignableSeatType) => Promise<boolean>
  setState: (s: CursorSeatState) => void
  setError: (e: string | null) => void
}

export function useCursorSeats(reloadKey: number): CursorSeats {
  const [state, setState] = useState<CursorSeatState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    call<CursorSeatState>("").then((r) => {
      if (!live) return
      if (r.ok) {
        setState(r.data)
        setError(null)
      } else setError(r.error)
    })
    return () => {
      live = false
    }
  }, [reloadKey])

  const assign = useCallback(async (personId: string, type: AssignableSeatType) => {
    const r = await call<CursorSeatState>("/assign", { person_ids: [personId], seat_type: type })
    if (!r.ok) {
      setError(r.error)
      return false
    }
    setState(r.data)
    setError(null)
    return true
  }, [])

  return { state, error, assign, setState, setError }
}

/** Seat type select for one person (disabled until migration 026 is applied). */
export function SeatTypeSelect({ seats, personId, label }: { seats: CursorSeats; personId: string; label: string }) {
  const [saving, setSaving] = useState(false)
  const available = !!seats.state?.available
  const value: AssignableSeatType = seats.state?.current[personId] ?? "none"
  return (
    <select
      aria-label={`Cursor seat for ${label}`}
      title={available ? "Cursor seat type from this month on" : "Cursor seat types need migration 026"}
      className={selectClass}
      value={value}
      disabled={!available || saving}
      onChange={async (e) => {
        setSaving(true)
        await seats.assign(personId, e.target.value as AssignableSeatType)
        setSaving(false)
      }}
    >
      {ASSIGNABLE_SEAT_TYPES.map((t) => (
        <option key={t} value={t}>
          Cursor: {SEAT_TYPE_LABEL[t]}
        </option>
      ))}
    </select>
  )
}

interface ImportReport {
  plan: RosterPlan
  roster: { counts: Record<AssignableSeatType, number>; total_usd: number }
  matched_total_usd: number
  from_month: string
  applied: number
  state?: CursorSeatState
}

const REASON: Record<RosterPlan["unmatched"][number]["reason"], string> = {
  email_not_found: "email not found",
  name_not_found: "name not found",
  name_ambiguous: "name matches more than one person",
  unknown_seat_type: "unknown seat type",
  duplicate_person: "person already matched by an earlier row",
  no_name: "no name or email",
}

function counts(c: Record<AssignableSeatType, number>) {
  return `${c.standard} Standard · ${c.premium} Premium · ${c.free} Free`
}

export function CursorSeatsCard({ seats, org }: { seats: CursorSeats; org: Org }) {
  const { state, error } = seats
  const [rates, setRates] = useState<Record<SeatType, string>>({ standard: "", premium: "", free: "" })
  const [csv, setCsv] = useState("")
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!state) return
    // Show the saved rates whenever they change on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRates({ standard: String(state.rates.standard), premium: String(state.rates.premium), free: String(state.rates.free) })
  }, [state])

  const saveRate = async (t: SeatType) => {
    setBusy(true)
    setMsg(null)
    const r = await call<CursorSeatState>("/rates", { seat_type: t, monthly_rate_usd: rates[t] })
    setBusy(false)
    if (!r.ok) return seats.setError(r.error)
    seats.setState(r.data)
    seats.setError(null)
    setMsg(`${SEAT_TYPE_LABEL[t]} rate saved from ${r.data.currentMonth}`)
  }

  const runImport = async (confirm: boolean) => {
    setBusy(true)
    setMsg(null)
    const r = await call<ImportReport>("/import", { csv, confirm })
    setBusy(false)
    if (!r.ok) return seats.setError(r.error)
    seats.setError(null)
    setReport(r.data)
    if (r.data.state) {
      seats.setState(r.data.state)
      setMsg(`Imported ${r.data.applied} seat assignments from ${r.data.from_month}`)
    }
  }

  const nameOf = (id: string) => {
    const p = org.people.find((x) => x.id === id)
    return p?.display_name || p?.email || id
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cursor seats</CardTitle>
        <CardDescription>
          The Cursor API doesn&apos;t report seat types, so they are set here. Each person&apos;s monthly seat fee is
          attributed to them and their team and counted in Cursor totals. Changes apply from this month on. When a
          Cursor month has an invoice actual, seats are part of that total, not added to it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="flex items-center gap-1 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {error}
          </p>
        )}
        {!state ? (
          !error && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : !state.available ? (
          <p className="flex items-center gap-1 text-sm text-muted-foreground" role="status">
            <AlertCircle className="h-4 w-4" /> {state.notice}
          </p>
        ) : (
          <>
            {state.summary && (
              <p className="text-sm" data-testid="cursor-seat-summary">
                {state.summary.month}: {counts(state.summary.counts)} = <strong>{usd(state.summary.total_usd)}</strong> / month
                {state.summary.counts.none > 0 && <span className="text-muted-foreground"> ({state.summary.counts.none} unassigned)</span>}
              </p>
            )}
            {state.recurringConflict && (
              <p className="flex items-center gap-1 text-sm text-amber-600" role="status">
                <AlertCircle className="h-4 w-4" /> A recurring Cursor cost also covers this month. While per-person seats
                exist it is not counted (it would bill the same seats twice); end it under Recurring costs.
              </p>
            )}
            {state.assignmentCount === 0 && (
              <p className="flex items-center gap-1 text-sm text-amber-600" role="status">
                <AlertCircle className="h-4 w-4" /> No seat types yet. Import the roster
                (database/seeds/cursor-seat-roster-2026-11-05.csv) below.
              </p>
            )}

            <div className="flex flex-wrap items-end gap-3">
              {SEAT_TYPES.map((t) => (
                <form
                  key={t}
                  className="flex items-end gap-1"
                  onSubmit={(e) => {
                    e.preventDefault()
                    saveRate(t)
                  }}
                >
                  <label className="text-sm">
                    <span className="block text-muted-foreground">{SEAT_TYPE_LABEL[t]} $/month</span>
                    <Input
                      aria-label={`${SEAT_TYPE_LABEL[t]} monthly rate`}
                      className="w-24"
                      type="number"
                      min={0}
                      step="0.01"
                      value={rates[t]}
                      onChange={(e) => setRates((r) => ({ ...r, [t]: e.target.value }))}
                    />
                  </label>
                  <Button type="submit" size="sm" variant="outline" disabled={busy || rates[t] === String(state.rates[t])}>
                    Save
                  </Button>
                </form>
              ))}
              <span className="text-sm text-muted-foreground">Unassigned: $0</span>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Import roster CSV</p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1 text-sm">
                  <Upload className="h-4 w-4" />
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    aria-label="Roster CSV file"
                    className="text-sm"
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      if (f) {
                        setCsv(await f.text())
                        setReport(null)
                      }
                    }}
                  />
                </label>
                <Button size="sm" variant="outline" disabled={busy || !csv.trim()} onClick={() => runImport(false)}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} Preview
                </Button>
                <Button size="sm" disabled={busy || !report || report.applied > 0} onClick={() => runImport(true)}>
                  Apply {report ? `${report.plan.assignments.length} matches` : ""}
                </Button>
              </div>
              {report && (
                <div className="space-y-1 rounded-md border border-border/50 p-3 text-sm" data-testid="cursor-roster-report">
                  <p>
                    Roster: {counts(report.roster.counts)} = {usd(report.roster.total_usd)}
                    {report.roster.counts.none > 0 && ` (${report.roster.counts.none} removed, no seat)`}
                  </p>
                  <p>
                    Matched {report.plan.assignments.length} rows: {counts(report.plan.counts)} = {usd(report.matched_total_usd)}
                    {" "}({report.plan.assignments.filter((a) => a.matched_by === "email").length} by email,{" "}
                    {report.plan.assignments.filter((a) => a.matched_by === "name").length} by name)
                  </p>
                  {report.plan.assignments.some((a) => a.removed) && (
                    <p>Removed (no billed seat): {report.plan.assignments.filter((a) => a.removed).map((a) => nameOf(a.person_id)).join(", ")}</p>
                  )}
                  {report.plan.unmatched.length > 0 && (
                    <div>
                      <p className="text-amber-600">Not matched ({report.plan.unmatched.length}), not imported:</p>
                      <ul className="ml-4 list-disc text-muted-foreground">
                        {report.plan.unmatched.map((u) => (
                          <li key={u.line}>
                            {u.name || "(no name)"} {u.email && `<${u.email}>`} ({u.seat_type}): {REASON[u.reason]}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
            {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}
