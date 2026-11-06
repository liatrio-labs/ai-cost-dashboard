"use client"

/**
 * Seat assignments (issue #26): split a seat-based manual tool's monthly
 * entry (Claude Ultra first) across people. Rows go through
 * PUT /api/admin/seat-assignments, which replaces the month's rows
 * atomically and never changes the month's total; unassigned seats stay in
 * an org-level remainder.
 */

import { formatMonthLong } from "@/lib/dashboard-types"
import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface Provider {
  id: string
  name: string
  display_name: string
}
interface Assignment {
  person_email: string
  seats: number
  cost_usd: number
}
interface Group {
  provider_id: string
  month: string
  seat_group_id: string | null
  total_usd: number
  total_seats: number
  price_per_seat: number
  assignments: Assignment[]
  remainder: { seats: number; cost_usd: number }
}
interface Person {
  id: string
  email: string
  display_name: string | null
}
interface Draft {
  person_email: string
  seats: string
  cost_usd: string
}

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"

function fmt(n: number): string {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const cents = (n: number) => Math.round(n * 100)

export function SeatAssignmentsCard({ onChanged }: { onChanged?: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [providerId, setProviderId] = useState("")
  const [month, setMonth] = useState("")
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [newEmail, setNewEmail] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/seat-assignments")
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setProviders(body.providers ?? [])
      setGroups(body.groups ?? [])
      setPeople(body.people ?? [])
      setProviderId((cur) => {
        const list: Provider[] = body.providers ?? []
        if (cur && list.some((p) => p.id === cur)) return cur
        return (list.find((p) => p.name === "claude-max") ?? list[0])?.id ?? ""
      })
    } catch (e: unknown) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to load seat entries" })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const months = useMemo(() => groups.filter((g) => g.provider_id === providerId), [groups, providerId])
  const group = months.find((g) => g.month === month) ?? null

  // Default to the latest month of the chosen tool.
  useEffect(() => {
    if (!months.some((g) => g.month === month)) setMonth(months[0]?.month ?? "")
  }, [months, month])

  // Reset the draft whenever the chosen month (or its saved state) changes.
  useEffect(() => {
    setDrafts(
      (group?.assignments ?? []).map((a) => ({
        person_email: a.person_email,
        seats: String(a.seats),
        cost_usd: String(a.cost_usd),
      }))
    )
  }, [group])

  const assignedSeats = drafts.reduce((s, d) => s + (Number(d.seats) || 0), 0)
  const assignedCents = drafts.reduce((s, d) => s + cents(Number(d.cost_usd) || 0), 0)
  const totalCents = group ? cents(group.total_usd) : 0
  const remainderSeats = (group?.total_seats ?? 0) - assignedSeats
  const remainderCents = totalCents - assignedCents
  const over = remainderSeats < 0 || remainderCents < 0
  const assignedEmails = new Set(drafts.map((d) => d.person_email.toLowerCase()))
  const pickable = people.filter((p) => !assignedEmails.has(p.email))

  function addPerson(email: string) {
    const e = email.trim().toLowerCase()
    if (!e || assignedEmails.has(e) || !group) return
    setDrafts((d) => [...d, { person_email: e, seats: "1", cost_usd: String(group.price_per_seat) }])
    setNewEmail("")
  }

  function update(i: number, patch: Partial<Draft>) {
    setDrafts((d) =>
      d.map((row, j) => {
        if (j !== i) return row
        const next = { ...row, ...patch }
        // Seats drive the default cost; an edited cost is kept until seats change.
        if (patch.seats !== undefined && group) next.cost_usd = String((Number(patch.seats) || 0) * group.price_per_seat)
        return next
      })
    )
  }

  async function save(assignments: Draft[]) {
    if (!group) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch("/api/admin/seat-assignments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: group.provider_id,
          month: group.month,
          expected_total_usd: group.total_usd,
          assignments: assignments.map((d) => ({
            person_email: d.person_email,
            seats: Number(d.seats),
            cost_usd: Number(d.cost_usd),
          })),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setMsg({
        ok: true,
        text: assignments.length
          ? `Saved ${body.assignments?.length ?? assignments.length} assignments; ${fmt(body.remainder?.cost_usd ?? 0)} stays unassigned`
          : "Cleared: the month is one org-level entry again",
      })
      await load()
      onChanged?.()
    } catch (e: unknown) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to save" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Seat assignments</CardTitle>
        <CardDescription>
          Assign a seat-based tool&apos;s monthly cost (e.g. Claude Ultra on personal cards) to people. The
          month&apos;s total never changes; unassigned seats stay Unassigned.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading seat entries…
          </p>
        ) : providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No seat-based tools yet. Add one above with “Seat-based subscription”.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Tool"
                className={SELECT_CLASS}
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Month"
                className={SELECT_CLASS}
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                disabled={months.length === 0}
              >
                {months.map((g) => (
                  <option key={g.month} value={g.month}>
                    {formatMonthLong(g.month)}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="ghost" onClick={load} className="gap-2" disabled={busy}>
                <RefreshCw className="h-3.5 w-3.5" /> Reload
              </Button>
            </div>

            {!group ? (
              <p className="text-sm text-muted-foreground">No monthly seat entries for this tool yet.</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {group.total_seats} seats × {fmt(group.price_per_seat)} = {fmt(group.total_usd)}
                </p>

                {drafts.length > 0 && (
                  <div className="divide-y divide-border/50 rounded-md border border-border/50">
                    {drafts.map((d, i) => (
                      <div key={d.person_email} className="flex flex-wrap items-center gap-2 p-2">
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {people.find((p) => p.email === d.person_email)?.display_name || d.person_email}
                        </span>
                        <Input
                          aria-label={`Seats for ${d.person_email}`}
                          type="number"
                          min="1"
                          step="1"
                          className="w-20"
                          value={d.seats}
                          onChange={(e) => update(i, { seats: e.target.value })}
                        />
                        <Input
                          aria-label={`Cost for ${d.person_email}`}
                          type="number"
                          min="0"
                          step="0.01"
                          className="w-28"
                          value={d.cost_usd}
                          onChange={(e) => update(i, { cost_usd: e.target.value })}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${d.person_email}`}
                          onClick={() => setDrafts((rows) => rows.filter((_, j) => j !== i))}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Add person"
                    className={SELECT_CLASS}
                    value=""
                    onChange={(e) => addPerson(e.target.value)}
                  >
                    <option value="">Add a person…</option>
                    {pickable.map((p) => (
                      <option key={p.id} value={p.email}>
                        {p.display_name ? `${p.display_name} (${p.email})` : p.email}
                      </option>
                    ))}
                  </select>
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      addPerson(newEmail)
                    }}
                  >
                    <Input
                      aria-label="Add by email"
                      type="email"
                      placeholder="or add by email"
                      className="w-56"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                    />
                    <Button type="submit" size="sm" variant="outline" className="gap-1" disabled={!newEmail.trim()}>
                      <Plus className="h-3.5 w-3.5" /> Add
                    </Button>
                  </form>
                </div>

                <div className="rounded-md bg-muted/40 p-2 text-xs" data-testid="seat-totals">
                  <p>
                    Assigned: {assignedSeats} of {group.total_seats} seats · {fmt(assignedCents / 100)} of{" "}
                    {fmt(group.total_usd)}
                  </p>
                  <p className={over ? "text-destructive" : "text-muted-foreground"}>
                    {over
                      ? "More than the month's total is assigned"
                      : `Unassigned remainder: ${remainderSeats} seats · ${fmt(remainderCents / 100)}`}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => save(drafts)} disabled={busy || over} className="gap-1">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save assignments
                  </Button>
                  {group.seat_group_id && (
                    <Button size="sm" variant="ghost" onClick={() => save([])} disabled={busy}>
                      Clear all
                    </Button>
                  )}
                </div>
              </>
            )}
          </>
        )}
        {msg && (
          <p className={`flex items-center gap-1 text-xs ${msg.ok ? "text-primary" : "text-destructive"}`}>
            {msg.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
            {msg.text}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
