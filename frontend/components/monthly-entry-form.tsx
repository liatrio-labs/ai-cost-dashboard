"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { CalendarIcon, Check, AlertCircle } from "lucide-react"

interface ProviderOption {
  id: string
  name: string
}

interface MonthlyEntryFormProps {
  /** Optional preloaded providers; if omitted the form fetches /api/providers. */
  providers?: ProviderOption[]
  onSaveSuccess?: () => void
}

function defaultMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

export function MonthlyEntryForm({ providers: providersProp, onSaveSuccess }: MonthlyEntryFormProps) {
  const [providers, setProviders] = useState<ProviderOption[]>(providersProp || [])
  const [loadingProviders, setLoadingProviders] = useState(!providersProp)

  const [providerId, setProviderId] = useState("")
  const [month, setMonth] = useState(defaultMonth())
  const [cost, setCost] = useState("")
  const [note, setNote] = useState("")

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (providersProp) {
      setProviders(providersProp)
      setLoadingProviders(false)
      return
    }
    let active = true
    ;(async () => {
      try {
        const res = await fetch("/api/providers")
        if (!res.ok) throw new Error("Failed to load providers")
        const data = await res.json()
        // /api/providers returns the provider array directly (successResponse).
        const list: ProviderOption[] = (Array.isArray(data) ? data : []).map((p: any) => ({
          id: p.id,
          name: p.display_name || p.name,
        }))
        if (active) setProviders(list)
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to load providers")
      } finally {
        if (active) setLoadingProviders(false)
      }
    })()
    return () => {
      active = false
    }
  }, [providersProp])

  // Month options: last 12 months through next month.
  const monthOptions = Array.from({ length: 14 }, (_, i) => {
    const date = new Date()
    date.setDate(1)
    date.setMonth(date.getMonth() - 12 + i)
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
    const label = date.toLocaleDateString("en-US", { month: "long", year: "numeric" })
    return { value, label }
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)

    const costNum = parseFloat(cost)
    if (!providerId) {
      setError("Please select a provider.")
      return
    }
    if (!Number.isFinite(costNum) || costNum <= 0) {
      setError("Please enter a cost greater than 0.")
      return
    }

    // First day of the chosen month as the timestamp.
    const timestamp = new Date(`${month}-01T12:00:00Z`).toISOString()

    setSaving(true)
    try {
      const res = await fetch("/api/costs/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: providerId,
          timestamp,
          model_name: "manual",
          cost_usd: costNum,
          metadata: {
            notes: note || "",
            entry_type: "monthly_manual",
            month,
          },
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Failed to save entry")
      }

      setSaved(true)
      setCost("")
      setNote("")
      onSaveSuccess?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save entry")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CalendarIcon className="h-5 w-5 text-primary" />
          Manual Cost Entry
        </CardTitle>
        <CardDescription>
          Record spend for providers without an API (e.g. ChatGPT). Pick a provider and month, enter
          the cost.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit}>
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="provider">Provider</FieldLabel>
                <Select value={providerId} onValueChange={setProviderId} disabled={loadingProviders}>
                  <SelectTrigger id="provider">
                    <SelectValue placeholder={loadingProviders ? "Loading…" : "Select provider"} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="month">Month</FieldLabel>
                <Select value={month} onValueChange={setMonth}>
                  <SelectTrigger id="month">
                    <SelectValue placeholder="Select month" />
                  </SelectTrigger>
                  <SelectContent>
                    {monthOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="cost">Cost (USD)</FieldLabel>
              <Input
                id="cost"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={cost}
                onChange={(e) => {
                  setCost(e.target.value)
                  setSaved(false)
                }}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="note">Note (optional)</FieldLabel>
              <Textarea
                id="note"
                placeholder="e.g. ChatGPT Team — 5 seats"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
              />
            </Field>

            {error && (
              <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
            {saved && (
              <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400">
                <Check className="h-4 w-4" />
                Entry saved.
              </div>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={saving}>
                {saving ? <Spinner className="mr-2 h-4 w-4" /> : null}
                Save Entry
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
