"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Loader2, CheckCircle2, AlertCircle, FileSpreadsheet, Plus, RefreshCw, LogOut, Users } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { MonthlyEntryForm } from "@/components/monthly-entry-form"
import { ManageTools, type ToolRow } from "@/components/admin/manage-tools"
import {
  MonthSelect,
  RecurringAmountFields,
  draftToBody,
  emptyDraft,
  monthChoices,
  type RecurringDraft,
} from "@/components/admin/recurring-cost"
import { currentMonthOf } from "@/lib/recurring-costs"
import { ManageEntries } from "@/components/admin/manage-entries"
import { SeatAssignmentsCard } from "@/components/admin/seat-assignments"
import { AdminsCard } from "@/components/admin/admins"
import { InvoiceOverridesCard } from "@/components/admin/invoice-overrides"
import { ForecastSettingsCard } from "@/components/admin/forecast-settings"
import { ForecastUnitsCard } from "@/components/admin/forecast-units"
import { ProviderPullCard } from "@/components/admin/provider-pull"
import { SyncFreshness } from "@/components/sync-freshness"
import { LiatrioMark } from "@/components/liatrio-logo"
import { ModeToggle } from "@/components/mode-toggle"

interface ProviderOption {
  id: string
  name: string
}

export function AdminClient() {
  const router = useRouter()

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
  // Issue #59: optional recurring monthly cost for the new tool.
  const [toolRecurring, setToolRecurring] = useState(false)
  const [toolRecurringDraft, setToolRecurringDraft] = useState<RecurringDraft>(emptyDraft(true))
  const [toolRecurringStart, setToolRecurringStart] = useState(() => currentMonthOf(new Date()))
  const [recurringReloadKey, setRecurringReloadKey] = useState(0)
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
    let recurring: Record<string, unknown> | undefined
    if (toolRecurring) {
      const parsed = draftToBody(toolRecurringDraft)
      if ("error" in parsed) {
        setAddToolMsg({ ok: false, text: parsed.error })
        return
      }
      recurring = { ...parsed.body, from_month: toolRecurringStart }
    }
    setAddingTool(true)
    try {
      const res = await fetch("/api/admin/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: name, seat_based: toolSeatBased, recurring }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setAddToolMsg({ ok: false, text: body.error || `HTTP ${res.status}` })
        return
      }
      if (recurring && body.recurring_saved === false) {
        setAddToolMsg({ ok: false, text: body.message || "Tool added, but its recurring cost wasn't saved." })
      } else if (recurring) {
        setAddToolMsg({ ok: true, text: `Added "${name}" with a recurring monthly cost. Manage it under Manage tools.` })
      } else {
        setAddToolMsg({ ok: true, text: `Added "${name}". It's now in the entry dropdown below.` })
      }
      setToolName("")
      setToolRecurringDraft(emptyDraft(toolSeatBased))
      setRecurringReloadKey((k) => k + 1)
      await loadProviders()
    } catch (err) {
      setAddToolMsg({ ok: false, text: (err instanceof Error && err.message) || "Request failed" })
    } finally {
      setAddingTool(false)
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
            <Link href="/admin/org">
              <Button variant="outline" size="sm" className="gap-2">
                <Users className="h-4 w-4" />
                Org structure
              </Button>
            </Link>
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
        {/* Per-provider sync freshness and warnings (issue #47) */}
        <SyncFreshness />

        {/* Pull data (issue #28: AI Gateway, date range, Sync keys now) */}
        <ProviderPullCard />

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
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={toolRecurring}
                  onChange={(e) => {
                    setToolRecurring(e.target.checked)
                    setToolRecurringDraft({ ...toolRecurringDraft, seatBased: toolSeatBased })
                  }}
                  className="h-4 w-4 accent-primary"
                />
                Monthly recurring cost (counts every month until changed or ended)
              </label>
              {toolRecurring ? (
                <div className="space-y-3 rounded-md border border-border/50 p-3">
                  <RecurringAmountFields draft={toolRecurringDraft} onChange={setToolRecurringDraft} idPrefix="new-tool" />
                  <div className="space-y-1 sm:max-w-xs">
                    <label htmlFor="new-tool-start" className="text-xs font-medium text-muted-foreground">
                      Start month
                    </label>
                    <MonthSelect
                      id="new-tool-start"
                      value={toolRecurringStart}
                      onChange={setToolRecurringStart}
                      months={monthChoices(currentMonthOf(new Date()))}
                    />
                  </div>
                </div>
              ) : null}
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

        {/* Team / department forecasts (issue #9) */}
        <Card>
          <CardHeader>
            <CardTitle>Team and department forecasts</CardTitle>
            <CardDescription>
              The org plateau is split across teams and departments by trailing spend, with
              Unassigned as its own unit. Override a unit&apos;s plateau or headcount here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ForecastUnitsCard />
          </CardContent>
        </Card>

        {/* Manage tools */}
        <Card>
          <CardHeader>
            <CardTitle>Manage tools</CardTitle>
            <CardDescription>
              Add a description and the platform&apos;s admin URL (where to pull more data) for each
              tool, set up, change or end a manual tool&apos;s monthly recurring cost, or delete a tool
              and its cost records.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ManageTools
              tools={toolRows}
              reloadKey={recurringReloadKey}
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

        {/* Invoice actuals per provider-month (issue #75) */}
        <InvoiceOverridesCard providers={providers} />

        <SeatAssignmentsCard onChanged={() => setEntriesReloadKey((k) => k + 1)} />

        {/* Admins (issue #71) */}
        <AdminsCard />
      </main>
    </div>
  )
}
