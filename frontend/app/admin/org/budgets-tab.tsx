"use client"

/**
 * "Budgets" tab of /admin/org (issue #49): monthly budgets per person, team
 * and project, each with this month's actual and #39 projection and a
 * "Projected over budget" badge, plus the alert settings (mode and which env
 * var names are set). Without migration 020 the tab shows a notice and no form.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, Loader2, Pencil, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import type { BudgetsResponse } from "@/lib/org/admin/budgets"
import type { BudgetScope, BudgetStatus } from "@/lib/budgets"
import { selectClass, usd, type Org } from "./shared"

const API = "/api/admin/org"

const SCOPE_LABEL: Record<BudgetScope, string> = { person: "Person", team: "Team", project: "Project" }

/** Never rejects: a network failure comes back as { ok: false, status: 0 }. */
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

export function BudgetStateBadge({ status }: { status: Pick<BudgetStatus, "state" | "subjectExists"> }) {
  if (!status.subjectExists) return <Badge variant="outline">subject deleted</Badge>
  if (status.state === "over") return <Badge variant="destructive">Over budget</Badge>
  if (status.state === "projected_over")
    return (
      <Badge variant="destructive" title="Current month projected to its end (issue #39) is over the budget">
        Projected over budget
      </Badge>
    )
  return <Badge variant="secondary">On track</Badge>
}

export function BudgetsTab({ org, reloadKey }: { org: Org; reloadKey: number }) {
  const [data, setData] = useState<BudgetsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState<BudgetScope>("team")
  const [subject, setSubject] = useState("")
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let live = true
    send("/budgets", "GET").then((res) => {
      if (!live) return
      if (res.ok) {
        setData(res.data as unknown as BudgetsResponse)
        setError(null)
      } else setError(res.data.error || `Failed to load (${res.status})`)
    })
    return () => {
      live = false
    }
  }, [reloadKey, tick])

  const subjects = useMemo(() => {
    if (scope === "person") return org.people.map((p) => ({ id: p.id, label: p.display_name ? `${p.display_name} (${p.email})` : p.email }))
    if (scope === "team") return org.teams.map((t) => ({ id: t.id, label: t.name }))
    return org.projects.map((p) => ({ id: p.id, label: `${p.name || p.external_project_id} (${org.providers.find((x) => x.id === p.provider_id)?.display_name ?? p.provider_id})` }))
  }, [org, scope])

  const save = async () => {
    const value = Number(amount)
    if (!subject || !(value > 0)) {
      setMsg({ ok: false, text: "Choose a subject and a monthly amount over $0." })
      return
    }
    setBusy(true)
    setMsg(null)
    const res = await send("/budgets", "POST", { scope, subject_id: subject, monthly_usd: value, note: note || null })
    setBusy(false)
    if (!res.ok) return setMsg({ ok: false, text: res.data.error || `Request failed (${res.status})` })
    setMsg({ ok: true, text: "Budget saved." })
    setSubject("")
    setAmount("")
    setNote("")
    refresh()
  }

  const remove = async (s: BudgetStatus) => {
    if (!window.confirm(`Delete the ${usd(s.budgetUsd)} budget for ${s.label}?`)) return
    setBusy(true)
    setMsg(null)
    const res = await send(`/budgets/${encodeURIComponent(s.budget.id)}`, "DELETE")
    setBusy(false)
    if (!res.ok) return setMsg({ ok: false, text: res.data.error || `Request failed (${res.status})` })
    setMsg({ ok: true, text: "Budget deleted." })
    refresh()
  }

  const edit = (s: BudgetStatus) => {
    setScope(s.budget.scope)
    setSubject(s.budget.subject_id)
    setAmount(String(s.budgetUsd))
    setNote(s.budget.note ?? "")
  }

  const alerts = data?.alerts

  return (
    <Card>
      <CardHeader>
        <CardTitle>Budgets</CardTitle>
        <CardDescription>
          Monthly budgets per person, team or project. The current month is projected to its end (issue #39); budgets projected over are flagged here and listed
          in Needs review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="flex items-center gap-1 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </p>
        )}
        {!data && !error && <Loader2 className="h-4 w-4 animate-spin" />}
        {data && !data.available && (
          <p role="status" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="migration-020-notice">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {data.notice}
          </p>
        )}
        {data && data.available && (
          <>
            {alerts && (
              <p className="text-xs text-muted-foreground" data-testid="alert-settings">
                Alerts: {alerts.mode === "live" ? "live" : `dry-run (logged, not sent; set ${alerts.env.mode}=live to send)`} · Slack{" "}
                {alerts.channels.slack ? "configured" : `off (${alerts.env.slackWebhook} not set)`} · Email{" "}
                {alerts.channels.email ? "configured" : `off (needs ${alerts.env.emailTo}, ${alerts.env.emailFrom} and ${alerts.env.resendKey})`}. At most one alert
                per person, team or project per month.
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <select
                aria-label="Budget scope"
                className={selectClass}
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as BudgetScope)
                  setSubject("")
                }}
              >
                <option value="person">Person</option>
                <option value="team">Team</option>
                <option value="project">Project</option>
              </select>
              <select aria-label="Budget subject" className={`${selectClass} max-w-xs`} value={subject} onChange={(e) => setSubject(e.target.value)}>
                <option value="">Choose {SCOPE_LABEL[scope].toLowerCase()}…</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <Input
                aria-label="Monthly budget (USD)"
                className="h-9 w-36"
                type="number"
                min="0"
                step="0.01"
                placeholder="Monthly USD"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <Input aria-label="Budget note" className="h-9 w-56" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button size="sm" disabled={busy} onClick={save}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Save budget
              </Button>
            </div>
            {msg && <p className={`text-sm ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</p>}
            {!data.statuses.length ? (
              <p className="text-sm text-muted-foreground">No budgets yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-2">Subject</th>
                      <th className="py-1 pr-2 text-right">Budget</th>
                      <th className="py-1 pr-2 text-right">Actual {data.month}</th>
                      <th className="py-1 pr-2 text-right">Projected</th>
                      <th className="py-1 pr-2 text-right">% of budget</th>
                      <th className="py-1 pr-2">Status</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.statuses.map((s) => (
                      <tr key={s.budget.id} data-testid="budget-row">
                        <td className="py-1 pr-2">
                          <span className="text-xs text-muted-foreground">{SCOPE_LABEL[s.budget.scope]}</span> {s.label}
                          {s.budget.note && <span className="ml-1 text-xs text-muted-foreground">· {s.budget.note}</span>}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono">{usd(s.budgetUsd)}</td>
                        <td className="py-1 pr-2 text-right font-mono">{usd(s.actual)}</td>
                        <td className="py-1 pr-2 text-right font-mono">{usd(s.projected)}</td>
                        <td className="py-1 pr-2 text-right font-mono">{Math.round(s.ratio * 100)}%</td>
                        <td className="py-1 pr-2">
                          <BudgetStateBadge status={s} />
                        </td>
                        <td className="py-1 text-right whitespace-nowrap">
                          <Button size="icon" variant="ghost" aria-label={`Edit budget for ${s.label}`} disabled={busy || !s.subjectExists} onClick={() => edit(s)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant="ghost" aria-label={`Delete budget for ${s.label}`} disabled={busy} onClick={() => remove(s)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
