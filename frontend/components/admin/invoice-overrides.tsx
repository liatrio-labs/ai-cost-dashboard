"use client"

/**
 * Invoice actuals (issue #75): set or clear the invoiced amount for one
 * provider + calendar month. The month then counts exactly the invoice: API
 * rows are scaled to it (attribution kept) and that month's manual entries and
 * recurring cost are replaced. Shows the API / usage value next to the
 * invoiced amount. Without migration 024 the card shows a notice and writes
 * are disabled. Uses /api/admin/invoice-overrides (requireAdmin).
 */

import { useCallback, useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, Receipt, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MonthSelect, monthLabel } from "@/components/admin/recurring-cost"
import { addMonths, currentMonthOf } from "@/lib/recurring-costs"

interface ProviderMonthValues {
  provider_id: string
  month: string
  api_usd: number
  manual_usd: number
  recurring_usd: number
  without_override_usd: number
}

interface OverrideView extends ProviderMonthValues {
  billed_amount_usd: number
  credits_usd: number | null
  notes: string | null
  invoice_ids: string[] | null
  entered_by: string | null
  entered_at: string | null
  delta_usd: number
}

interface State {
  available: boolean
  notice: string | null
  currentMonth: string
  overrides: OverrideView[]
}

export interface InvoiceProviderOption {
  id: string
  name: string
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedUsd = (n: number) => `${n < 0 ? "−" : "+"}${usd(Math.abs(n))}`

/** Complete months, newest first: the 24 before the current month. */
export function invoiceMonthChoices(current: string): string[] {
  return Array.from({ length: 24 }, (_, i) => addMonths(current, -(i + 1)))
}

export function InvoiceOverridesCard({ providers }: { providers: InvoiceProviderOption[] }) {
  const [state, setState] = useState<State | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [providerId, setProviderId] = useState("")
  const [month, setMonth] = useState("")
  const [amount, setAmount] = useState("")
  const [credits, setCredits] = useState("")
  const [invoiceIds, setInvoiceIds] = useState("")
  const [notes, setNotes] = useState("")
  const [preview, setPreview] = useState<ProviderMonthValues | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/invoice-overrides")
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setState(body as State)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load invoice actuals")
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // The API value of the chosen provider-month, shown before saving.
  useEffect(() => {
    if (!providerId || !month) {
      setPreview(null)
      return
    }
    let cancelled = false
    fetch(`/api/admin/invoice-overrides?provider_id=${encodeURIComponent(providerId)}&month=${encodeURIComponent(month)}`)
      .then((r) => r.json().then((b) => (r.ok ? b : Promise.reject(new Error(b.error || `HTTP ${r.status}`)))))
      .then((b) => !cancelled && setPreview((b.preview as ProviderMonthValues) ?? null))
      .catch(() => !cancelled && setPreview(null))
    return () => {
      cancelled = true
    }
  }, [providerId, month])

  const writable = !!state?.available
  const current = state?.currentMonth ?? currentMonthOf(new Date())
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id
  const existing = state?.overrides.find((o) => o.provider_id === providerId && o.month === month)
  const amountNum = amount.trim() === "" ? NaN : Number(amount)
  const canSave = writable && !!providerId && !!month && Number.isFinite(amountNum) && amountNum >= 0 && !busy

  async function save() {
    if (!canSave) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch("/api/admin/invoice-overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider_id: providerId,
          month,
          billed_amount_usd: amountNum,
          credits_usd: credits.trim() === "" ? null : Number(credits),
          invoice_ids: invoiceIds,
          notes,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setState(body as State)
      setMsg({ ok: true, text: `Saved the ${monthLabel(month)} invoice actual for ${providerName(providerId)}.` })
      setAmount("")
      setCredits("")
      setInvoiceIds("")
      setNotes("")
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to save" })
    } finally {
      setBusy(false)
    }
  }

  async function clear(o: OverrideView) {
    if (!window.confirm(`Clear the ${monthLabel(o.month)} invoice actual for ${providerName(o.provider_id)}? The month goes back to API, manual and recurring amounts.`)) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(
        `/api/admin/invoice-overrides?provider_id=${encodeURIComponent(o.provider_id)}&month=${encodeURIComponent(o.month)}`,
        { method: "DELETE" }
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setState(body as State)
      setMsg({ ok: true, text: `Cleared the ${monthLabel(o.month)} invoice actual for ${providerName(o.provider_id)}.` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to clear" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="h-5 w-5" />
          Invoice actuals
        </CardTitle>
        <CardDescription>
          Record what a provider actually invoiced for a complete calendar month. That month then
          counts exactly the invoiced amount everywhere (dashboard, breakdowns, budgets, forecasts):
          API usage is scaled to it so per-person and per-team attribution is kept, and the
          month&apos;s manual entries and recurring cost are replaced, not added.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {loadError}
          </p>
        ) : null}
        {state && !state.available ? (
          <p className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="invoice-migration-notice">
            <AlertCircle className="h-4 w-4 shrink-0" /> {state.notice}
          </p>
        ) : null}
        {!state && !loadError ? <Loader2 className="h-4 w-4 animate-spin" /> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="invoice-provider" className="text-sm font-medium">Tool</label>
            <Select value={providerId} onValueChange={setProviderId} disabled={!writable}>
              <SelectTrigger id="invoice-provider" className="w-full">
                <SelectValue placeholder="Select tool" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor="invoice-month" className="text-sm font-medium">Month</label>
            <MonthSelect id="invoice-month" value={month} onChange={setMonth} months={invoiceMonthChoices(current)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="invoice-amount" className="text-sm font-medium">Invoiced amount (USD, net of credits)</label>
            <Input id="invoice-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!writable} />
          </div>
          <div className="space-y-1">
            <label htmlFor="invoice-credits" className="text-sm font-medium">Credits (optional, informational)</label>
            <Input id="invoice-credits" type="number" min="0" step="0.01" value={credits} onChange={(e) => setCredits(e.target.value)} disabled={!writable} />
          </div>
          <div className="space-y-1">
            <label htmlFor="invoice-ids" className="text-sm font-medium">Invoice ids (optional, comma separated)</label>
            <Input id="invoice-ids" value={invoiceIds} onChange={(e) => setInvoiceIds(e.target.value)} disabled={!writable} />
          </div>
          <div className="space-y-1">
            <label htmlFor="invoice-notes" className="text-sm font-medium">Notes (optional)</label>
            <Input id="invoice-notes" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!writable} />
          </div>
        </div>

        {preview ? (
          <p className="text-sm text-muted-foreground" data-testid="invoice-preview">
            {providerName(preview.provider_id)}, {monthLabel(preview.month)}: API usage {usd(preview.api_usd)}
            {preview.manual_usd ? `, manual ${usd(preview.manual_usd)}` : ""}
            {preview.recurring_usd ? `, recurring ${usd(preview.recurring_usd)}` : ""}; counted today{" "}
            {usd(existing ? existing.billed_amount_usd : preview.without_override_usd)}
            {existing ? " (invoice actual already set; saving replaces it)" : ""}.
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={!canSave}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {existing ? "Replace invoice actual" : "Set invoice actual"}
          </Button>
          {msg ? (
            <span className={`flex items-center gap-1 text-sm ${msg.ok ? "text-green-600" : "text-destructive"}`}>
              {msg.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />} {msg.text}
            </span>
          ) : null}
        </div>

        {state?.overrides.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="invoice-overrides-table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Tool</th>
                  <th className="py-2 pr-3 font-medium">Month</th>
                  <th className="py-2 pr-3 text-right font-medium">API / usage</th>
                  <th className="py-2 pr-3 text-right font-medium">Without invoice</th>
                  <th className="py-2 pr-3 text-right font-medium">Invoiced</th>
                  <th className="py-2 pr-3 text-right font-medium">Difference</th>
                  <th className="py-2 pr-3 font-medium">Invoices / notes</th>
                  <th className="py-2 pr-3 font-medium">Entered</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {state.overrides.map((o) => (
                  <tr key={`${o.provider_id}|${o.month}`} className="border-b last:border-0">
                    <td className="py-2 pr-3">{providerName(o.provider_id)}</td>
                    <td className="py-2 pr-3">{monthLabel(o.month)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{usd(o.api_usd)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{usd(o.without_override_usd)}</td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {usd(o.billed_amount_usd)}
                      {o.credits_usd ? <span className="block text-xs text-muted-foreground">credits {usd(o.credits_usd)}</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">{signedUsd(o.delta_usd)}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {[...(o.invoice_ids ?? [])].join(", ")}
                      {o.notes ? <span className="block">{o.notes}</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {o.entered_by ?? ""}
                      {o.entered_at ? <span className="block">{new Date(o.entered_at).toLocaleDateString("en-US")}</span> : null}
                    </td>
                    <td className="py-2 text-right">
                      <Button variant="ghost" size="sm" onClick={() => clear(o)} disabled={!writable || busy} aria-label={`Clear ${providerName(o.provider_id)} ${o.month}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : state?.available ? (
          <p className="text-sm text-muted-foreground">No invoice actuals yet.</p>
        ) : null}
      </CardContent>
    </Card>
  )
}
