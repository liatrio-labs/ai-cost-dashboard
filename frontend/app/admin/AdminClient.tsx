"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Download, Loader2, CheckCircle2, AlertCircle, FileSpreadsheet, Plus, RefreshCw, LogOut } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { MonthlyEntryForm } from "@/components/monthly-entry-form"
import { ManageTools, type ToolRow } from "@/components/admin/manage-tools"
import { ManageEntries } from "@/components/admin/manage-entries"
import { ForecastSettingsCard } from "@/components/admin/forecast-settings"
import { LiatrioMark } from "@/components/liatrio-logo"
import { ModeToggle } from "@/components/mode-toggle"

// Providers that have an automated collector (the "Pull" list). Manual/seat
// tools added via the admin form below are NOT pullable and don't appear here.
const PROVIDERS: { id: string; name: string }[] = [
  { id: "anthropic", name: "Anthropic API (platform.claude.com)" },
  { id: "claude-ai", name: "Claude.ai (Enterprise Analytics)" },
  { id: "openai", name: "OpenAI API (platform.openai.com)" },
  { id: "cursor", name: "Cursor (Admin API)" },
  { id: "vercel", name: "Vercel (Usage API)" },
  { id: "apify", name: "Apify (Usage API)" },
  { id: "windsurf", name: "Windsurf (CascadeAnalytics + seats)" },
]

interface ProviderOption {
  id: string
  name: string
}

interface PullResult {
  loading?: boolean
  status?: string
  recordsStored?: number
  reason?: string
  error?: string
}

export function AdminClient() {
  const router = useRouter()
  const [backfill, setBackfill] = useState(false)
  const [results, setResults] = useState<Record<string, PullResult>>({})

  // Providers: id+name for the entry dropdown, plus raw rows for "Manage tools".
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [toolRows, setToolRows] = useState<ToolRow[]>([])
  // Bumped to make the entries list reload after a new entry/tool change.
  const [entriesReloadKey, setEntriesReloadKey] = useState(0)

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/providers")
      if (!res.ok) return
      const data = await res.json()
      const rows: ToolRow[] = Array.isArray(data) ? data : []
      setToolRows(rows)
      setProviders(rows.map((p) => ({ id: p.id, name: p.display_name || p.name })))
    } catch {
      /* non-fatal: the entry form falls back to fetching /api/providers itself */
    }
  }, [])

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push("/login")
    router.refresh()
  }

  // Add-a-tool form state.
  const [toolName, setToolName] = useState("")
  const [toolSeatBased, setToolSeatBased] = useState(true)
  const [addingTool, setAddingTool] = useState(false)
  const [addToolMsg, setAddToolMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Explicit "update the dashboard" control (auto-refresh covers the common case).
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  async function refreshDashboard() {
    setRefreshing(true)
    setRefreshMsg(null)
    try {
      const res = await fetch("/api/admin/refresh", { method: "POST" })
      setRefreshMsg(res.ok ? "Dashboard refreshed." : "Refresh failed.")
    } catch {
      setRefreshMsg("Refresh failed.")
    } finally {
      setRefreshing(false)
    }
  }

  async function addTool(e: React.FormEvent) {
    e.preventDefault()
    setAddToolMsg(null)
    const name = toolName.trim()
    if (!name) {
      setAddToolMsg({ ok: false, text: "Enter a tool name." })
      return
    }
    setAddingTool(true)
    try {
      const res = await fetch("/api/admin/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: name, seat_based: toolSeatBased }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setAddToolMsg({ ok: false, text: body.error || `HTTP ${res.status}` })
        return
      }
      setAddToolMsg({ ok: true, text: `Added "${name}". It's now in the entry dropdown below.` })
      setToolName("")
      await loadProviders()
    } catch (err: any) {
      setAddToolMsg({ ok: false, text: err?.message || "Request failed" })
    } finally {
      setAddingTool(false)
    }
  }

  async function pull(provider: string) {
    setResults((r) => ({ ...r, [provider]: { loading: true } }))
    try {
      const res = await fetch("/api/admin/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, backfill }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResults((r) => ({ ...r, [provider]: { error: body.error || `HTTP ${res.status}` } }))
        return
      }
      setResults((r) => ({
        ...r,
        [provider]: {
          status: body.status,
          recordsStored: body.records_stored ?? 0,
          reason: body.reason,
          error: body.error,
        },
      }))
    } catch (e: any) {
      setResults((r) => ({ ...r, [provider]: { error: e?.message || "Request failed" } }))
    }
  }

  async function pullAll() {
    for (const p of PROVIDERS) {
      // sequential so the backend isn't hammered all at once
      // eslint-disable-next-line no-await-in-loop
      await pull(p.id)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <LiatrioMark className="h-7" />
            <h1 className="text-lg font-semibold">Admin · Data ingest</h1>
          </div>
          <div className="flex items-center gap-2">
            {refreshMsg && <span className="text-xs text-muted-foreground">{refreshMsg}</span>}
            <ModeToggle />
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={refreshDashboard}
              disabled={refreshing}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh dashboard
            </Button>
            <Link href="/">
              <Button variant="ghost" size="sm" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back to dashboard
              </Button>
            </Link>
            <Button variant="ghost" size="sm" className="gap-2" onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
              Log out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
        {/* Pull data */}
        <Card>
          <CardHeader>
            <CardTitle>Pull data from providers</CardTitle>
            <CardDescription>
              Trigger collection on demand. Daily collection also runs automatically.
              Enable backfill to pull the last 90 days.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-md border border-border/50 p-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={backfill}
                  onChange={(e) => setBackfill(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                Backfill last 90 days
              </label>
              <Button onClick={pullAll} className="gap-2">
                <Download className="h-4 w-4" />
                Pull all
              </Button>
            </div>

            <div className="divide-y divide-border/50">
              {PROVIDERS.map((p) => {
                const r = results[p.id]
                return (
                  <div key={p.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      {r && !r.loading && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          {r.error ? (
                            <>
                              <AlertCircle className="h-3 w-3 text-destructive" />
                              <span className="text-destructive">{r.error}</span>
                            </>
                          ) : r.status === "skipped" ? (
                            <>
                              <AlertCircle className="h-3 w-3 text-amber-500" />
                              {r.reason || "Skipped (no API key set)"}
                            </>
                          ) : r.status === "error" ? (
                            <>
                              <AlertCircle className="h-3 w-3 text-destructive" />
                              <span className="text-destructive">{r.error || "Error"}</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="h-3 w-3 text-primary" />
                              Stored {r.recordsStored} record{r.recordsStored === 1 ? "" : "s"}
                            </>
                          )}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => pull(p.id)}
                      disabled={r?.loading}
                      className="gap-2"
                    >
                      {r?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      Pull
                    </Button>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Add a new tool */}
        <Card>
          <CardHeader>
            <CardTitle>Add a new tool</CardTitle>
            <CardDescription>
              Register a tool that has no collection API (e.g. a seat-based SaaS subscription). Once
              added, record its monthly spend below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={addTool} className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <label htmlFor="toolName" className="text-sm font-medium">
                    Tool name
                  </label>
                  <Input
                    id="toolName"
                    placeholder="e.g. Lovable, GitHub Copilot"
                    value={toolName}
                    onChange={(e) => {
                      setToolName(e.target.value)
                      setAddToolMsg(null)
                    }}
                  />
                </div>
                <Button type="submit" disabled={addingTool} className="gap-2">
                  {addingTool ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add tool
                </Button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={toolSeatBased}
                  onChange={(e) => setToolSeatBased(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                Seat-based subscription
              </label>
              {addToolMsg && (
                <p
                  className={`flex items-center gap-1 text-xs ${
                    addToolMsg.ok ? "text-primary" : "text-destructive"
                  }`}
                >
                  {addToolMsg.ok ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <AlertCircle className="h-3 w-3" />
                  )}
                  {addToolMsg.text}
                </p>
              )}
            </form>
          </CardContent>
        </Card>

        {/* Forecast settings */}
        <Card>
          <CardHeader>
            <CardTitle>Forecast</CardTitle>
            <CardDescription>
              The spend forecast plateaus based on total employee count. Update headcount to scale
              the projection.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ForecastSettingsCard />
          </CardContent>
        </Card>

        {/* Manage tools */}
        <Card>
          <CardHeader>
            <CardTitle>Manage tools</CardTitle>
            <CardDescription>
              Add a description and the platform&apos;s admin URL (where to pull more data) for each
              tool, or delete a tool and its cost records.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ManageTools
              tools={toolRows}
              onChanged={() => {
                loadProviders()
                setEntriesReloadKey((k) => k + 1)
              }}
            />
          </CardContent>
        </Card>

        {/* Manual entry */}
        <Card>
          <CardHeader>
            <CardTitle>Monthly entry</CardTitle>
            <CardDescription>
              Record monthly spend for a tool without an API (e.g. ChatGPT, or a seat-based tool you
              added above). Toggle seat-based pricing to enter seats × price per seat.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <MonthlyEntryForm
              providers={providers.length ? providers : undefined}
              onSaveSuccess={() => setEntriesReloadKey((k) => k + 1)}
            />
            <Separator />
            <Link href="/dashboard/chatgpt">
              <Button variant="ghost" size="sm" className="gap-2">
                <FileSpreadsheet className="h-4 w-4" />
                ChatGPT CSV import
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Manage entries */}
        <Card>
          <CardHeader>
            <CardTitle>Manage entries</CardTitle>
            <CardDescription>
              Edit or delete previously recorded manual entries. Changes update the dashboard
              immediately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ManageEntries reloadKey={entriesReloadKey} />
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
