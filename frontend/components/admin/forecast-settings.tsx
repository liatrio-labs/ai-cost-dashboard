"use client"

import { useState, useEffect } from "react"
import { Loader2, Save, CheckCircle2, AlertCircle, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface Settings {
  employees: number
  baselineEmployees: number
  baselinePlateauUsd: number
  perPersonPct: number
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`
}

export function ForecastSettingsCard({ onSaved }: { onSaved?: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [employees, setEmployees] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const res = await fetch("/api/admin/settings")
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!active) return
        setSettings(data.forecast)
        setEmployees(String(data.forecast.employees))
      } catch {
        /* ignore — card just shows defaults once loaded */
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  // Live plateau preview as the count changes.
  const empNum = parseInt(employees, 10)
  const previewPlateau =
    settings && Number.isFinite(empNum)
      ? Math.max(
          0,
          settings.baselinePlateauUsd *
            (1 + settings.perPersonPct * (empNum - settings.baselineEmployees))
        )
      : null

  async function save() {
    if (!Number.isFinite(empNum) || empNum < 0) {
      setMsg({ ok: false, text: "Enter a valid employee count." })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employees: empNum }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg({ ok: false, text: body.error || `HTTP ${res.status}` })
        return
      }
      setSettings(body.forecast)
      setMsg({ ok: true, text: `Saved — forecast plateau ≈ ${usd(body.plateau)}/mo.` })
      onSaved?.()
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || "Request failed" })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </p>
    )
  }

  const pctLabel = settings ? `${(settings.perPersonPct * 100).toFixed(0)}%` : "2%"
  const dirty = settings ? empNum !== settings.employees : false

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <label htmlFor="employees" className="flex items-center gap-1.5 text-sm font-medium">
            <Users className="h-4 w-4" />
            Total employees
          </label>
          <Input
            id="employees"
            type="number"
            min="0"
            step="1"
            className="w-40"
            value={employees}
            onChange={(e) => {
              setEmployees(e.target.value)
              setMsg(null)
            }}
          />
        </div>
        <Button onClick={save} disabled={saving || !dirty} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </Button>
      </div>

      {previewPlateau != null && settings && (
        <p className="text-sm text-muted-foreground">
          Forecast plateaus at{" "}
          <span className="font-medium text-foreground">{usd(previewPlateau)}/mo</span>
          {empNum !== settings.baselineEmployees && (
            <>
              {" "}
              ({empNum > settings.baselineEmployees ? "+" : ""}
              {empNum - settings.baselineEmployees} vs baseline {settings.baselineEmployees})
            </>
          )}
          . Baseline {settings.baselineEmployees} employees ≈ {usd(settings.baselinePlateauUsd)}/mo;
          each employee adjusts it by {pctLabel}.
        </p>
      )}

      {msg && (
        <p
          className={`flex items-center gap-1 text-xs ${
            msg.ok ? "text-primary" : "text-destructive"
          }`}
        >
          {msg.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          {msg.text}
        </p>
      )}
    </div>
  )
}
