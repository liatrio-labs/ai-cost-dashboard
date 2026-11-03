"use client"

/**
 * Admin card for team / department forecast overrides (issue #9). Each unit's
 * plateau defaults to the org plateau x its trailing 3-month share of spend;
 * an admin can replace it with a fixed plateau or a headcount (at the org's
 * per-employee plateau). Backed by /api/admin/forecast-units.
 */

import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCurrency } from "@/lib/dashboard-types"

type Level = "team" | "department"

interface UnitRow {
  key: string
  name: string
  unassigned: boolean
  trailingSpend: number
  share: number
  allocatedPlateau: number
  plateau: number
  override: { plateauUsd: number | null; headcount: number | null } | null
  nextMonth: { month: string; total: number } | null
}

interface Payload {
  orgPlateau: number
  employees: number
  trailingMonths: string[]
  team: UnitRow[]
  department: UnitRow[]
}

const parseAmount = (s: string): number | null | "invalid" => {
  if (!s.trim()) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : "invalid"
}

function UnitEditor({ level, unit, onSaved }: { level: Level; unit: UnitRow; onSaved: (p: Payload) => void }) {
  const [plateau, setPlateau] = useState(unit.override?.plateauUsd != null ? String(unit.override.plateauUsd) : "")
  const [headcount, setHeadcount] = useState(unit.override?.headcount != null ? String(unit.override.headcount) : "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(clear = false) {
    const p = clear ? null : parseAmount(plateau)
    const h = clear ? null : parseAmount(headcount)
    if (p === "invalid" || h === "invalid") {
      setError("Enter non-negative numbers.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/forecast-units", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level, key: unit.key, plateauUsd: p, headcount: h }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      if (clear) {
        setPlateau("")
        setHeadcount("")
      }
      onSaved(body as Payload)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{unit.name}</TableCell>
      <TableCell className="text-right tabular-nums">{(unit.share * 100).toFixed(1)}%</TableCell>
      <TableCell className="text-right tabular-nums">{formatCurrency(unit.allocatedPlateau)}</TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`${unit.name} plateau override (USD per month)`}
            placeholder="Plateau $/mo"
            type="number"
            min="0"
            className="h-8 w-32"
            value={plateau}
            onChange={(e) => setPlateau(e.target.value)}
          />
          <Input
            aria-label={`${unit.name} headcount override`}
            placeholder="Headcount"
            type="number"
            min="0"
            step="1"
            className="h-8 w-24"
            value={headcount}
            onChange={(e) => setHeadcount(e.target.value)}
          />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => save(false)}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
          </Button>
          {unit.override && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(true)}>
              Clear
            </Button>
          )}
        </div>
        {error && (
          <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" /> {error}
          </p>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatCurrency(unit.plateau)}
        {unit.override && <span className="ml-1 text-xs text-muted-foreground">(override)</span>}
      </TableCell>
      <TableCell className="text-right tabular-nums">{unit.nextMonth ? formatCurrency(unit.nextMonth.total) : "—"}</TableCell>
    </TableRow>
  )
}

export function ForecastUnitsCard() {
  const [data, setData] = useState<Payload | null>(null)
  const [level, setLevel] = useState<Level>("team")
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/forecast-units")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData((await res.json()) as Payload)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error && !data) return <p className="text-sm text-destructive">Couldn&apos;t load team forecasts: {error}</p>
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </p>
    )
  }

  const rows = data[level]
  const window = data.trailingMonths.length ? `${data.trailingMonths[0]} to ${data.trailingMonths.at(-1)}` : "no data yet"

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Each unit&apos;s plateau defaults to the org plateau ({formatCurrency(data.orgPlateau)}/mo) times its share of
          spend over {window}. A headcount override uses {formatCurrency(data.employees > 0 ? data.orgPlateau / data.employees : 0)}
          /person; a plateau override wins over headcount. Overrides change only that unit.
        </p>
        <div className="flex gap-1" role="group" aria-label="Forecast level">
          {(["team", "department"] as const).map((l) => (
            <Button key={l} size="sm" variant={l === level ? "default" : "outline"} onClick={() => setLevel(l)}>
              {l === "team" ? "Teams" : "Departments"}
            </Button>
          ))}
        </div>
      </div>
      <Table aria-label={`${level} forecasts`}>
        <TableHeader>
          <TableRow>
            <TableHead>{level === "team" ? "Team" : "Department"}</TableHead>
            <TableHead className="text-right">Share</TableHead>
            <TableHead className="text-right">Allocated</TableHead>
            <TableHead>Override</TableHead>
            <TableHead className="text-right">Plateau</TableHead>
            <TableHead className="text-right">Next month</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((u) => (
            <UnitEditor key={`${level}:${u.key}:${JSON.stringify(u.override)}`} level={level} unit={u} onSaved={setData} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
