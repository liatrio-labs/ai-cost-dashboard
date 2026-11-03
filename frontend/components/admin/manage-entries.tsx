"use client"

import { useState, useEffect, useCallback } from "react"
import { Loader2, Save, Trash2, Pencil, X, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface EntryRow {
  id: string
  provider_name: string
  month: string
  cost_usd: number
  entry_type: string
  seats: number | null
  price_per_seat: number | null
  note: string
  seat_group_id?: string | null
  person_email?: string | null
  remainder?: boolean
}

/** A split seat month (issue #26): every row sharing one seat_group_id. */
interface SeatGroupItem {
  kind: "group"
  key: string
  seat_group_id: string
  provider_name: string
  month: string
  rows: EntryRow[]
  total: number
}

type Item = { kind: "single"; key: string; row: EntryRow } | SeatGroupItem

/** Group split seat rows under their month; plain entries stay one per row. Order is kept. */
export function groupEntries(entries: EntryRow[]): Item[] {
  const items: Item[] = []
  const groups = new Map<string, SeatGroupItem>()
  for (const row of entries) {
    const gid = row.seat_group_id
    if (!gid) {
      items.push({ kind: "single", key: row.id, row })
      continue
    }
    let g = groups.get(gid)
    if (!g) {
      g = { kind: "group", key: `group:${gid}`, seat_group_id: gid, provider_name: row.provider_name, month: row.month, rows: [], total: 0 }
      groups.set(gid, g)
      items.push(g)
    }
    g.rows.push(row)
    g.total = Math.round((g.total + Number(row.cost_usd)) * 1e6) / 1e6
  }
  for (const g of groups.values()) {
    // People first (by email), the unassigned remainder last.
    g.rows.sort((a, b) => Number(!!a.remainder) - Number(!!b.remainder) || (a.person_email ?? "").localeCompare(b.person_email ?? ""))
  }
  return items
}

function fmt(n: number): string {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function ManageEntries({ reloadKey, onChanged }: { reloadKey?: number; onChanged?: () => void }) {
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Edit-form state.
  const [eCost, setECost] = useState("")
  const [eSeats, setESeats] = useState("")
  const [ePrice, setEPrice] = useState("")
  const [eNote, setENote] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/entries")
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      setEntries((await res.json()) as EntryRow[])
    } catch (e: unknown) {
      setError((e instanceof Error && e.message) || "Failed to load entries")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  function startEdit(row: EntryRow) {
    setEditing(row.id)
    setConfirmDelete(null)
    const seatBased = row.entry_type === "monthly_seats"
    setESeats(seatBased && row.seats != null ? String(row.seats) : "")
    setEPrice(seatBased && row.price_per_seat != null ? String(row.price_per_seat) : "")
    setECost(seatBased ? "" : String(row.cost_usd))
    setENote(row.note || "")
  }

  async function saveEdit(row: EntryRow) {
    setBusy(true)
    try {
      const seatBased = row.entry_type === "monthly_seats"
      const payload: Record<string, unknown> = { id: row.id, note: eNote }
      if (seatBased) {
        payload.seats = Number(eSeats)
        payload.price_per_seat = Number(ePrice)
      } else {
        payload.cost_usd = Number(eCost)
      }
      const res = await fetch("/api/admin/entries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      setEditing(null)
      await load()
      onChanged?.()
    } catch (e: unknown) {
      setError((e instanceof Error && e.message) || "Failed to save")
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string, isGroup = false) {
    setBusy(true)
    try {
      const param = isGroup ? `seat_group_id=${encodeURIComponent(id)}` : `id=${encodeURIComponent(id)}`
      const res = await fetch(`/api/admin/entries?${param}`, { method: "DELETE" })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      setConfirmDelete(null)
      await load()
      onChanged?.()
    } catch (e: unknown) {
      setError((e instanceof Error && e.message) || "Failed to delete")
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading entries…
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{entries.length} manual entries</p>
        <Button size="sm" variant="ghost" onClick={load} className="gap-2">
          <RefreshCw className="h-3.5 w-3.5" /> Reload
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No manual entries yet.</p>
      ) : (
        <div className="divide-y divide-border/50 rounded-md border border-border/50">
          {groupEntries(entries).map((item) => {
            if (item.kind === "group") {
              const people = item.rows.filter((r) => !r.remainder).length
              const deleting = confirmDelete === item.key
              return (
                <div key={item.key} className="space-y-2 p-3" data-testid="seat-group">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {item.provider_name} · {item.month}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {fmt(item.total)} split across {people} {people === 1 ? "person" : "people"} · edit in Seat assignments
                      </p>
                    </div>
                    {!deleting && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setConfirmDelete(item.key)
                          setEditing(null)
                        }}
                        className="shrink-0 gap-1 text-destructive hover:text-destructive"
                        aria-label={`Delete ${item.provider_name} ${item.month}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  <ul className="space-y-0.5 border-l border-border/50 pl-3 text-xs text-muted-foreground">
                    {item.rows.map((r) => (
                      <li key={r.id} className="flex justify-between gap-2">
                        <span className="truncate">
                          {r.remainder ? "Unassigned" : r.person_email} · {r.seats ?? "?"} seats
                        </span>
                        <span className="tabular-nums">{fmt(r.cost_usd)}</span>
                      </li>
                    ))}
                  </ul>
                  {deleting && (
                    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1">
                      <span className="text-xs text-destructive">Delete this month ({item.rows.length} rows)?</span>
                      <Button size="sm" variant="destructive" onClick={() => remove(item.seat_group_id, true)} disabled={busy}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Yes, delete"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={busy}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              )
            }
            const row = item.row
            const seatBased = row.entry_type === "monthly_seats"
            const isEditing = editing === row.id
            return (
              <div key={row.id} className="space-y-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {row.provider_name} · {row.month}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {seatBased
                        ? `${row.seats ?? "?"} seats × ${fmt(row.price_per_seat ?? 0)} = ${fmt(row.cost_usd)}`
                        : fmt(row.cost_usd)}
                      {row.note ? ` · ${row.note}` : ""}
                    </p>
                  </div>
                  {!isEditing && confirmDelete !== row.id && (
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" onClick={() => startEdit(row)} className="gap-1">
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setConfirmDelete(row.id)
                          setEditing(null)
                        }}
                        className="gap-1 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>

                {confirmDelete === row.id && (
                  <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1">
                    <span className="text-xs text-destructive">Delete this entry?</span>
                    <Button size="sm" variant="destructive" onClick={() => remove(row.id)} disabled={busy}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Yes, delete"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={busy}>
                      Cancel
                    </Button>
                  </div>
                )}

                {isEditing && (
                  <div className="space-y-2 rounded-md border border-border/50 bg-muted/30 p-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {seatBased ? (
                        <>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            placeholder="Seats"
                            value={eSeats}
                            onChange={(e) => setESeats(e.target.value)}
                          />
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="Price per seat"
                            value={ePrice}
                            onChange={(e) => setEPrice(e.target.value)}
                          />
                        </>
                      ) : (
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Cost (USD)"
                          value={eCost}
                          onChange={(e) => setECost(e.target.value)}
                        />
                      )}
                      <Input
                        placeholder="Note (optional)"
                        value={eNote}
                        onChange={(e) => setENote(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => saveEdit(row)} disabled={busy} className="gap-1">
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={busy} className="gap-1">
                        <X className="h-4 w-4" /> Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
