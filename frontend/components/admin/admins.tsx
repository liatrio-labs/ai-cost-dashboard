"use client"

/**
 * Admins (issue #71): env-allowlist admins (locked, "from environment") and
 * admins added here (admin_users, migration 023), with who added them and
 * when. Add @liatrio.com addresses only; remove with confirm; you can't
 * remove yourself and env admins can't be removed. Uses /api/admin/admins.
 */

import { useCallback, useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, Lock, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface AdminRow {
  email: string
  added_by: string | null
  added_at: string
}
interface AdminsState {
  me: string
  env_admins: string[]
  env_domains: string[]
  admins: AdminRow[]
  migration_applied: boolean
  notice?: string
}

const DOMAIN = "liatrio.com"

function isLiatrioEmail(email: string): boolean {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(email.trim().toLowerCase())
  return !!m && m[2] === DOMAIN
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

export function AdminsCard() {
  const [state, setState] = useState<AdminsState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/admins")
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setState(body as AdminsState)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load admins")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const writable = !!state?.migration_applied
  const trimmed = email.trim()
  const emailOk = isLiatrioEmail(trimmed)

  async function add() {
    if (!emailOk || !writable) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setState(body as AdminsState)
      setMsg({ ok: true, text: `Added ${trimmed.toLowerCase()} as an admin.` })
      setEmail("")
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to add admin" })
    } finally {
      setBusy(false)
    }
  }

  async function remove(target: string) {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/admin/admins?email=${encodeURIComponent(target)}&confirm=true`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setState(body as AdminsState)
      setMsg({ ok: true, text: `Removed ${target} as an admin.` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed to remove admin" })
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  const envSet = new Set(state?.env_admins ?? [])
  const tableRows = (state?.admins ?? []).filter((a) => !envSet.has(a.email))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admins</CardTitle>
        <CardDescription>
          Admins can open /admin and /admin/org and see the admin-only parts of the dashboard. Admins from the
          environment are always admins and can only be changed in the hosting environment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !state ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading admins…
          </div>
        ) : loadError && !state ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {loadError}
          </p>
        ) : state ? (
          <>
            {!state.migration_applied && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <span>{state.notice ?? "Migration 023 not applied: adding and removing admins is unavailable."}</span>
              </div>
            )}

            <ul className="divide-y divide-border/50 rounded-md border border-border/50">
              {state.env_admins.map((a) => (
                <li key={`env-${a}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="font-medium">{a}</span>
                  {a === state.me && <span className="text-xs text-muted-foreground">(you)</span>}
                  <Badge variant="secondary" className="gap-1">
                    <Lock className="h-3 w-3" /> from environment
                  </Badge>
                </li>
              ))}
              {state.env_domains.map((d) => (
                <li key={`domain-${d}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="font-medium">Everyone @{d}</span>
                  <Badge variant="secondary" className="gap-1">
                    <Lock className="h-3 w-3" /> from environment (ADMIN_DOMAINS)
                  </Badge>
                </li>
              ))}
              {tableRows.map((a) => {
                const isMe = a.email === state.me
                return (
                  <li key={a.email} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-medium">{a.email}</span>
                    {isMe && <span className="text-xs text-muted-foreground">(you)</span>}
                    <span className="text-xs text-muted-foreground">
                      added {a.added_by ? `by ${a.added_by} ` : ""}on {fmtDate(a.added_at)}
                    </span>
                    <span className="ml-auto">
                      {confirming === a.email ? (
                        <span className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1">
                          <span className="text-xs text-destructive">Remove {a.email} as an admin?</span>
                          <Button size="sm" variant="destructive" onClick={() => remove(a.email)} disabled={busy}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                            Yes, remove
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-2 text-destructive hover:text-destructive"
                          onClick={() => setConfirming(a.email)}
                          disabled={busy || isMe || !writable}
                          title={isMe ? "You can't remove yourself" : undefined}
                        >
                          <Trash2 className="h-4 w-4" />
                          Remove
                        </Button>
                      )}
                    </span>
                  </li>
                )
              })}
              {!tableRows.length && state.migration_applied && (
                <li className="px-3 py-2 text-sm text-muted-foreground">No admins added here yet.</li>
              )}
            </ul>

            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                add()
              }}
            >
              <div className="min-w-64 flex-1 space-y-1">
                <label htmlFor="new-admin-email" className="text-xs font-medium text-muted-foreground">
                  Add an admin (@{DOMAIN} only)
                </label>
                <Input
                  id="new-admin-email"
                  type="email"
                  placeholder={`first.last@${DOMAIN}`}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={!writable || busy}
                />
              </div>
              <Button type="submit" className="gap-2" disabled={!writable || busy || !emailOk}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add admin
              </Button>
            </form>
            {trimmed && !emailOk && (
              <p className="text-xs text-destructive">Only @{DOMAIN} addresses can be admins.</p>
            )}
            {msg && (
              <p className={`flex items-center gap-1 text-xs ${msg.ok ? "text-primary" : "text-destructive"}`}>
                {msg.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                {msg.text}
              </p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
