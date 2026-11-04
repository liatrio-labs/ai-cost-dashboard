"use client"

/**
 * Recurring monthly cost UI (issue #59): the amount / seats x price fields
 * shared by "Add a new tool" and "Manage tools", and the per-tool editor
 * (add, change from a month, end). Writes go to /api/admin/recurring-costs.
 */

import { useCallback, useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, Repeat, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { addMonths, cents, covers, currentMonthOf, toMonth, type RecurringCost } from "@/lib/recurring-costs"

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
}

/** Months from `back` months ago through `ahead` months ahead of `current`. */
export function monthChoices(current: string, back = 12, ahead = 12): string[] {
  return Array.from({ length: back + ahead + 1 }, (_, i) => addMonths(current, i - back))
}

const usd = (n: number | string) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function describeSegment(c: RecurringCost): string {
  const amount = `${usd(c.monthly_cost_usd)}/mo`
  const seats = c.seats != null && c.price_per_seat != null ? ` (${c.seats} × ${usd(c.price_per_seat)})` : ""
  const range = c.end_month
    ? `${monthLabel(toMonth(c.start_month))} – ${monthLabel(toMonth(c.end_month))}`
    : `from ${monthLabel(toMonth(c.start_month))}`
  return `${amount}${seats}, ${range}`
}

export interface RecurringDraft {
  seatBased: boolean
  amount: string
  seats: string
  price: string
}

export const emptyDraft = (seatBased: boolean): RecurringDraft => ({ seatBased, amount: "", seats: "", price: "" })

/** The JSON fields for /api/admin/recurring-costs, or an error message. */
export function draftToBody(d: RecurringDraft): { body: Record<string, number> } | { error: string } {
  if (d.seatBased) {
    const seats = Number(d.seats)
    const price = Number(d.price)
    if (!Number.isInteger(seats) || seats < 1) return { error: "Seats must be a whole number of at least 1." }
    if (d.price.trim() === "" || !Number.isFinite(price) || price < 0) return { error: "Enter a price per seat." }
    return { body: { seats, price_per_seat: price } }
  }
  const amount = Number(d.amount)
  if (d.amount.trim() === "" || !Number.isFinite(amount) || amount < 0) return { error: "Enter a monthly amount." }
  return { body: { monthly_cost_usd: amount } }
}

export function RecurringAmountFields({
  draft,
  onChange,
  idPrefix,
}: {
  draft: RecurringDraft
  onChange: (d: RecurringDraft) => void
  idPrefix: string
}) {
  const total = cents(Number(draft.seats) * cents(Number(draft.price)))
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.seatBased}
          onChange={(e) => onChange({ ...draft, seatBased: e.target.checked })}
          className="h-4 w-4 accent-primary"
        />
        Seats × price per seat
      </label>
      {draft.seatBased ? (
        <div className="grid gap-2 sm:grid-cols-3 sm:items-end">
          <div className="space-y-1">
            <label htmlFor={`${idPrefix}-seats`} className="text-xs font-medium text-muted-foreground">
              Seats
            </label>
            <Input
              id={`${idPrefix}-seats`}
              type="number"
              min="1"
              step="1"
              placeholder="e.g. 18"
              value={draft.seats}
              onChange={(e) => onChange({ ...draft, seats: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${idPrefix}-price`} className="text-xs font-medium text-muted-foreground">
              Price per seat (USD/mo)
            </label>
            <Input
              id={`${idPrefix}-price`}
              type="number"
              min="0"
              step="0.01"
              placeholder="e.g. 200.00"
              value={draft.price}
              onChange={(e) => onChange({ ...draft, price: e.target.value })}
            />
          </div>
          <p className="pb-2 text-sm text-muted-foreground">
            = <span className="font-medium text-foreground">{Number.isFinite(total) ? usd(total) : "$0.00"}</span>/mo
          </p>
        </div>
      ) : (
        <div className="space-y-1 sm:max-w-xs">
          <label htmlFor={`${idPrefix}-amount`} className="text-xs font-medium text-muted-foreground">
            Monthly amount (USD)
          </label>
          <Input
            id={`${idPrefix}-amount`}
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={draft.amount}
            onChange={(e) => onChange({ ...draft, amount: e.target.value })}
          />
        </div>
      )}
    </div>
  )
}

export function MonthSelect({
  id,
  value,
  onChange,
  months,
  placeholder,
  noneLabel,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  months: string[]
  placeholder?: string
  /** Adds a "no month" choice with value "". */
  noneLabel?: string
}) {
  return (
    <Select value={value || (noneLabel ? "none" : "")} onValueChange={(v) => onChange(v === "none" ? "" : v)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder ?? "Select month"} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel ? <SelectItem value="none">{noneLabel}</SelectItem> : null}
        {months.map((m) => (
          <SelectItem key={m} value={m}>
            {monthLabel(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** /api/admin/recurring-costs, reloadable. available is null while loading. */
export function useRecurringCosts(reloadKey = 0) {
  const [state, setState] = useState<{ available: boolean | null; costs: RecurringCost[] }>({ available: null, costs: [] })
  const [bump, setBump] = useState(0)
  const reload = useCallback(() => setBump((b) => b + 1), [])
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const res = await fetch("/api/admin/recurring-costs")
        const body = await res.json().catch(() => ({}))
        if (!active) return
        if (!res.ok) setState({ available: false, costs: [] })
        else setState({ available: !!body.available, costs: Array.isArray(body.costs) ? body.costs : [] })
      } catch {
        if (active) setState({ available: false, costs: [] })
      }
    })()
    return () => {
      active = false
    }
  }, [reloadKey, bump])
  return { ...state, reload }
}

async function postRecurring(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch("/api/admin/recurring-costs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.ok) return null
  const b = await res.json().catch(() => ({}))
  return b.error || `HTTP ${res.status}`
}

/**
 * One tool's recurring cost in "Manage tools": its segments, and a form to
 * add one, change it from a month onward, or end it.
 */
export function RecurringCostEditor({
  providerId,
  seatBasedDefault,
  costs,
  available,
  onChanged,
}: {
  providerId: string
  seatBasedDefault: boolean
  /** Every segment (all providers); filtered here. */
  costs: RecurringCost[]
  available: boolean | null
  onChanged: () => void
}) {
  const current = currentMonthOf(new Date())
  const months = monthChoices(current)
  const mine = costs.filter((c) => c.provider_id === providerId).sort((a, b) => a.start_month.localeCompare(b.start_month))
  const active = mine.find((c) => covers(c, current)) ?? null
  const later = mine.filter((c) => toMonth(c.start_month) > current)
  const past = mine.filter((c) => c.end_month && toMonth(c.end_month) < current)

  const [mode, setMode] = useState<"idle" | "change" | "end">("idle")
  const [draft, setDraft] = useState<RecurringDraft>(emptyDraft(seatBasedDefault))
  const [from, setFrom] = useState(current)
  const [end, setEnd] = useState("")
  const [note, setNote] = useState("")
  const [lastMonth, setLastMonth] = useState(current)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  if (available === null) return null
  if (!available) {
    return (
      <p className="text-xs text-muted-foreground">
        Recurring monthly costs need database migration 022, which isn&apos;t applied yet.
      </p>
    )
  }

  function startChange() {
    const base = active ?? later[0] ?? null
    setDraft(
      base
        ? {
            seatBased: base.seats != null,
            amount: String(Number(base.monthly_cost_usd)),
            seats: base.seats != null ? String(base.seats) : "",
            price: base.price_per_seat != null ? String(Number(base.price_per_seat)) : "",
          }
        : emptyDraft(seatBasedDefault)
    )
    setFrom(current)
    setEnd(base?.end_month ? toMonth(base.end_month) : "")
    setNote(base?.notes ?? "")
    setMsg(null)
    setMode("change")
  }

  async function save() {
    const parsed = draftToBody(draft)
    if ("error" in parsed) return setMsg({ ok: false, text: parsed.error })
    if (end && end < from) return setMsg({ ok: false, text: "The end month can't be before the start month." })
    setBusy(true)
    setMsg(null)
    try {
      const error = await postRecurring({
        provider_id: providerId,
        from_month: from,
        ...parsed.body,
        end_month: end || null,
        notes: note,
      })
      if (error) return setMsg({ ok: false, text: error })
      setMode("idle")
      setMsg({ ok: true, text: `Saved from ${monthLabel(from)}. Earlier months are unchanged.` })
      onChanged()
    } catch (e) {
      setMsg({ ok: false, text: (e instanceof Error && e.message) || "Request failed" })
    } finally {
      setBusy(false)
    }
  }

  async function endIt() {
    setBusy(true)
    setMsg(null)
    try {
      const error = await postRecurring({ provider_id: providerId, from_month: addMonths(lastMonth, 1), end: true })
      if (error) return setMsg({ ok: false, text: error })
      setMode("idle")
      setMsg({ ok: true, text: `Ended after ${monthLabel(lastMonth)}.` })
      onChanged()
    } catch (e) {
      setMsg({ ok: false, text: (e instanceof Error && e.message) || "Request failed" })
    } finally {
      setBusy(false)
    }
  }

  const idPrefix = `rc-${providerId}`
  return (
    <div className="space-y-2 rounded-md border border-border/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Repeat className="h-3.5 w-3.5" />
          Monthly recurring cost
        </p>
        {mode === "idle" ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={startChange}>
              {mine.length ? "Change" : "Add recurring cost"}
            </Button>
            {active || later.length ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setLastMonth(current)
                  setMsg(null)
                  setMode("end")
                }}
              >
                End
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {mine.length ? (
        <ul className="space-y-0.5 text-sm">
          {active ? <li>Now: {describeSegment(active)}</li> : <li className="text-muted-foreground">Not active this month.</li>}
          {later.map((c) => (
            <li key={c.id} className="text-muted-foreground">
              Scheduled: {describeSegment(c)}
            </li>
          ))}
          {past.length ? (
            <li className="text-xs text-muted-foreground">Earlier: {past.map(describeSegment).join("; ")}</li>
          ) : null}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          None. A recurring cost counts every month without a manual entry; a manual entry for a month replaces it for that month.
        </p>
      )}

      {mode === "change" ? (
        <div className="space-y-3 pt-1">
          <RecurringAmountFields draft={draft} onChange={setDraft} idPrefix={idPrefix} />
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={`${idPrefix}-from`} className="text-xs font-medium text-muted-foreground">
                {mine.length ? "Takes effect from" : "Start month"}
              </label>
              <MonthSelect id={`${idPrefix}-from`} value={from} onChange={setFrom} months={months} />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${idPrefix}-end`} className="text-xs font-medium text-muted-foreground">
                End month (optional)
              </label>
              <MonthSelect
                id={`${idPrefix}-end`}
                value={end}
                onChange={setEnd}
                months={months.filter((m) => m >= from)}
                noneLabel="No end (ongoing)"
              />
            </div>
          </div>
          <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          {from < current ? (
            <p className="text-xs text-muted-foreground">
              {monthLabel(from)} is in the past: months from then on that have no manual entry will count this cost.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save recurring cost
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("idle")} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {mode === "end" ? (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div className="space-y-1">
            <label htmlFor={`${idPrefix}-last`} className="text-xs font-medium text-muted-foreground">
              Last month it counts for
            </label>
            <MonthSelect id={`${idPrefix}-last`} value={lastMonth} onChange={setLastMonth} months={months} />
          </div>
          <Button size="sm" variant="destructive" onClick={endIt} disabled={busy} className="gap-1">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            End recurring cost
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("idle")} disabled={busy}>
            Cancel
          </Button>
        </div>
      ) : null}

      {msg ? (
        <p className={`flex items-center gap-1 text-xs ${msg.ok ? "text-primary" : "text-destructive"}`}>
          {msg.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          {msg.text}
        </p>
      ) : null}
    </div>
  )
}
