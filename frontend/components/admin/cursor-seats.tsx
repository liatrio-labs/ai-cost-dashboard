"use client"

/**
 * Cursor seat types (migration 026), edited under Seat assignments on /admin
 * (issue #92; previously a select on each /admin/org People row). The card
 * has the billing cycle's seat summary (20th-to-20th, issue #82), the
 * admin-editable per-cycle rates, the roster CSV backfill and a per-person
 * seat type list. Changes go through /api/admin/org/cursor-seats, apply from
 * the cycle billed this calendar month onward and carry forward until
 * changed; earlier cycles never change. People views only show the fee.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
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
import type { Person } from "@/lib/org/types"

/** A person the seat list can show: the /api/admin/org people rows. */
export type SeatPerson = Pick<Person, "id" | "email" | "display_name"> & { active?: boolean | null }

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })

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
  /** Set one person's seat type from the current cycle on; resolves true on success. */
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
      title={
        available && seats.state
          ? `Cursor seat type from the ${seats.state.cycle.label} cycle on, until changed`
          : "Cursor seat types need migration 026"
      }
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "2026-11" -> "Nov 2026" */
function monthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

function counts(c: Record<AssignableSeatType, number>) {
  return `${c.standard} Standard · ${c.premium} Premium · ${c.free} Free`
}

/**
 * Per-person seat types: active people plus anyone (even inactive) who holds
 * a seat, filterable. Each select saves through the assign endpoint.
 */
function SeatList({
  seats,
  people,
  peopleError,
}: {
  seats: CursorSeats
  /** null while the people directory is still loading. */
  people: SeatPerson[] | null
  peopleError?: string | null
}) {
  const [filter, setFilter] = useState("")
  const current = seats.state?.current
  const q = filter.trim().toLowerCase()
  const rows = useMemo(
    () =>
      (people ?? [])
        .filter((p) => p.active !== false || (current?.[p.id] ?? "none") !== "none")
        .filter((p) => !q || p.email.toLowerCase().includes(q) || (p.display_name ?? "").toLowerCase().includes(q))
        .sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email)),
    [people, current, q]
  )
  return (
    <div className="space-y-2" data-testid="cursor-seat-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Seat type per person ({rows.length})</p>
        <Input
          aria-label="Filter Cursor seat people"
          className="w-56"
          placeholder="Filter people"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="max-h-96 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/50">
        {rows.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              {p.display_name || p.email}
              {p.display_name && <span className="ml-2 text-muted-foreground">{p.email}</span>}
              {p.active === false && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}
            </span>
            <SeatTypeSelect seats={seats} personId={p.id} label={p.email} />
          </div>
        ))}
        {peopleError ? (
          <p className="flex items-center gap-1 p-2 text-sm text-destructive" role="alert">
            <AlertCircle className="h-4 w-4" /> {peopleError}
          </p>
        ) : people === null ? (
          <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground" data-testid="cursor-seat-people-loading">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading people…
          </p>
        ) : (
          rows.length === 0 && <p className="p-2 text-sm text-muted-foreground">No people match.</p>
        )}
      </div>
    </div>
  )
}

export function CursorSeatsCard({
  seats,
  people,
  peopleError = null,
}: {
  seats: CursorSeats
  /** null while the people directory is still loading. */
  people: SeatPerson[] | null
  /** A failed people load, kept apart from the seat API error so a later seats success can't hide it. */
  peopleError?: string | null
}) {
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
    setMsg(`${SEAT_TYPE_LABEL[t]} rate saved from the ${r.data.cycle.label} cycle`)
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
      setMsg(`Imported ${r.data.applied} seat assignments from the ${r.data.state.cycle.label} cycle`)
    }
  }

  const nameOf = (id: string) => {
    const p = people?.find((x) => x.id === id)
    return p?.display_name || p?.email || id
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cursor seats</CardTitle>
        <CardDescription>
          The Cursor API doesn&apos;t report seat types, so they are set here, per person. Seats bill per cycle, from the 20th
          to the 20th; each cycle&apos;s fee counts in the calendar month the cycle starts in. Each person&apos;s seat
          fee is attributed to them and their team and counted in Cursor totals. A seat type carries into every later
          cycle until you change it or set it to Unassigned; earlier cycles never change. When a Cursor month has an
          invoice actual, seats are part of that total, not added to it.
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
            <p className="text-sm" data-testid="cursor-seat-cycle">
              Editing cycle <strong>{state.cycle.label}</strong> (counts in {monthLabel(state.cycle.key)}); changes apply
              from this cycle on.
              {state.cycleInProgress.key !== state.cycle.key && (
                <span className="text-muted-foreground">
                  {" "}
                  The cycle in progress, {state.cycleInProgress.label}, was billed in {monthLabel(state.cycleInProgress.key)} and
                  stays as it is.
                </span>
              )}
            </p>
            {state.summary && (
              <p className="text-sm" data-testid="cursor-seat-summary">
                {state.summary.cycle.label}: {counts(state.summary.counts)} = <strong>{usd(state.summary.total_usd)}</strong> / cycle
                {state.summary.counts.none > 0 && <span className="text-muted-foreground"> ({state.summary.counts.none} unassigned)</span>}
              </p>
            )}
            {state.recurringConflict && (
              <p className="flex items-center gap-1 text-sm text-amber-600" role="status">
                <AlertCircle className="h-4 w-4" /> A recurring Cursor cost also covers {monthLabel(state.cycle.key)}. While per-person seats
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
                    <span className="block text-muted-foreground">{SEAT_TYPE_LABEL[t]} $/cycle</span>
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

            <SeatList seats={seats} people={people} peopleError={peopleError} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The Cursor seats card as it renders on /admin under Seat assignments: loads
 * the people directory from /api/admin/org and the seat state from
 * /api/admin/org/cursor-seats.
 */
export function CursorSeatAssignmentsCard() {
  const seats = useCursorSeats(0)
  const [people, setPeople] = useState<SeatPerson[] | null>(null)
  const [peopleError, setPeopleError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch("/api/admin/org")
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!live) return
        if (!res.ok) return setPeopleError((body as { error?: string }).error || `Failed to load people (${res.status})`)
        setPeople(((body as { people?: SeatPerson[] }).people ?? []) as SeatPerson[])
      })
      .catch((e) => live && setPeopleError(e instanceof Error && e.message ? e.message : "Failed to load people"))
    return () => {
      live = false
    }
  }, [])

  return <CursorSeatsCard seats={seats} people={people} peopleError={peopleError} />
}
