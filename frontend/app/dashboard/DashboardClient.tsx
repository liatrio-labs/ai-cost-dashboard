"use client"

import { useState, useEffect, useCallback } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import {
  LayoutDashboard,
  LineChart as LineChartIcon,
  TableProperties,
  CalendarDays,
  Inbox,
  Settings,
  LogOut,
  Network,
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent } from "@/components/ui/card"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

import { KPICards } from "@/components/kpi-cards"
import { SpendBreakdownChart } from "@/components/spend-breakdown-chart"
import { TrendChart } from "@/components/trend-chart"
import { ForecastChart } from "@/components/forecast-chart"
import { ModelBreakdownChart } from "@/components/model-breakdown-chart"
import { ToolsTable } from "@/components/tools-table"
import { LiatrioMark } from "@/components/liatrio-logo"
import { ModeToggle } from "@/components/mode-toggle"
import { OrgFilterBar } from "@/components/org/org-filter-bar"
import { OrgView } from "@/components/org/org-view"
import { formatMonthLong, formatRangeLabel, type DashboardData } from "@/lib/dashboard-types"
import type { BreakdownData } from "@/lib/dashboard/breakdown"
import {
  hasFilters,
  parseFilters,
  parsePeriod,
  toQueryString,
  type DashboardFilters,
  type PeriodParams,
} from "@/lib/dashboard/filters"

const VIEWS = ["dashboard", "trends", "tools", "org"] as const
type View = (typeof VIEWS)[number]

export function DashboardClient({ isAdmin = false }: { isAdmin?: boolean }) {
  const router = useRouter()
  const pathname = usePathname() || "/"
  // Period, filters and tab live in the URL (issue #8) so views are shareable.
  const searchParams = useSearchParams()
  const period = parsePeriod(searchParams)
  const filters = parseFilters(searchParams)
  const viewParam = searchParams.get("view")
  const view: View = (VIEWS as readonly string[]).includes(viewParam ?? "") ? (viewParam as View) : "dashboard"

  const [data, setData] = useState<DashboardData | null>(null)
  const [breakdown, setBreakdown] = useState<BreakdownData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rangeOpen, setRangeOpen] = useState(false)
  const [draftFrom, setDraftFrom] = useState("")
  const [draftTo, setDraftTo] = useState("")

  const navigate = useCallback(
    (next: { period?: PeriodParams; filters?: DashboardFilters; view?: View }) => {
      const qs = new URLSearchParams(
        toQueryString(next.period ?? parsePeriod(searchParams), next.filters ?? parseFilters(searchParams)).slice(1)
      )
      const v = next.view ?? view
      if (v !== "dashboard") qs.set("view", v)
      const s = qs.toString()
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams, view]
  )

  const loadData = useCallback(
    async (qs: string) => {
      setError(null)
      try {
        // Breakdown is best-effort: if it fails, the dashboard still renders as before.
        const breakdownReq = fetch(`/api/dashboard/breakdown${qs}`)
          .then((r) => (r.ok ? (r.json() as Promise<BreakdownData>) : null))
          .catch(() => null)
        const res = await fetch(`/api/dashboard${qs}`)

        if (res.status === 401) {
          router.push("/login")
          return
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || "Failed to load dashboard data")
        }

        // GET /api/dashboard returns the contract object directly (successResponse).
        const json: DashboardData = await res.json()
        setData(json)
        setBreakdown(await breakdownReq)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard data")
      } finally {
        setLoading(false)
      }
    },
    [router]
  )

  // Load on mount and whenever the period or filters in the URL change.
  const dataQuery = toQueryString(period, filters)
  useEffect(() => {
    loadData(dataQuery)
  }, [dataQuery, loadData])

  if (loading && !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Spinner className="h-8 w-8" />
          <p className="text-muted-foreground">Loading AI spend data…</p>
        </div>
      </div>
    )
  }

  const filtered = hasFilters(filters)
  // A filter that matches nothing empties `months` too; that's "no spend for
  // these filters", not the first-run empty state, so the filter bar stays.
  const hasAnyData = !!data && (data.months.length > 0 || filtered)
  const hasPeriodData = !!data && data.tools.length > 0
  // Org filters and the Org tab appear only once an org structure exists, so
  // the dashboard is unchanged until then.
  const showOrg = !!breakdown?.orgConfigured
  const onFilters = (f: DashboardFilters) => navigate({ filters: f })

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <LiatrioMark className="h-8" />
            <div>
              <h1 className="text-lg font-semibold text-foreground">AI Spend Dashboard</h1>
              {data && hasAnyData && (
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-3 w-3 text-muted-foreground" />
                  {/* Month dropdown (defaults to the current month) */}
                  <Select
                    value={data.period.mode === "month" ? data.selectedMonth ?? "" : ""}
                    onValueChange={(value) => navigate({ period: { month: value } })}
                  >
                    <SelectTrigger className="h-6 w-auto gap-1 border-0 bg-transparent p-0 text-xs text-muted-foreground hover:text-foreground focus:ring-0">
                      <SelectValue placeholder="Custom range" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.months.map((month) => (
                        <SelectItem key={month} value={month}>
                          {formatMonthLong(month)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Custom date range */}
                  <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {data.period.mode === "range"
                          ? formatRangeLabel(data.period.start, data.period.end)
                          : "Custom range"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-auto space-y-3 p-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">From</label>
                        <input
                          type="date"
                          value={draftFrom || data.dataStart || ""}
                          min={data.dataStart || undefined}
                          max={data.dataEnd || undefined}
                          onChange={(e) => setDraftFrom(e.target.value)}
                          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">To</label>
                        <input
                          type="date"
                          value={draftTo || data.dataEnd || ""}
                          min={data.dataStart || undefined}
                          max={data.dataEnd || undefined}
                          onChange={(e) => setDraftTo(e.target.value)}
                          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                        />
                      </div>
                      <Button
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          const start = draftFrom || data.dataStart || ""
                          const end = draftTo || data.dataEnd || ""
                          if (start && end) {
                            navigate({ period: { start, end } })
                            setRangeOpen(false)
                          }
                        }}
                      >
                        Apply range
                      </Button>
                      {data.dataStart && (
                        <p className="text-[10px] text-muted-foreground">
                          Data available from {data.dataStart}
                        </p>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <ModeToggle />
            {isAdmin && (
              <Link href="/admin">
                <Button variant="ghost" size="sm" className="gap-2">
                  <Settings className="h-4 w-4" />
                  Admin
                </Button>
              </Link>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              onClick={async () => {
                const supabase = createClient()
                await supabase.auth.signOut()
                router.push("/login")
                router.refresh()
              }}
            >
              <LogOut className="h-4 w-4" />
              Log out
            </Button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {error && (
          <div className="mb-6 rounded-md bg-destructive/10 p-4 text-destructive">{error}</div>
        )}

        {showOrg && hasAnyData && (
          <Card className="mb-6 border-border/50 bg-card/50 backdrop-blur">
            <CardContent className="py-4">
              <OrgFilterBar options={breakdown!.options} filters={filters} onChange={onFilters} />
            </CardContent>
          </Card>
        )}

        {!hasAnyData ? (
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="rounded-full bg-muted p-4">
                <Inbox className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">No spend data yet</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Once the collectors run, your AI spend will appear here.
                {isAdmin
                  ? " Use the Admin area to pull data or add a manual entry."
                  : ""}
              </p>
              {isAdmin && (
                <Link href="/admin" className="mt-4">
                  <Button className="gap-2">
                    <Settings className="h-4 w-4" />
                    Go to Admin
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>
        ) : !hasPeriodData ? (
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="rounded-full bg-muted p-4">
                <Inbox className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">No spend in this period</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                There&apos;s no recorded spend for the selected period
                {filtered ? " and filters" : ""}. Pick another month or range
                above{filtered ? ", or clear the filters" : ""}.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Tabs
            value={view === "org" && !showOrg ? "dashboard" : view}
            onValueChange={(v) => navigate({ view: v as View })}
            className="space-y-6"
          >
            <TabsList className={`grid w-full ${showOrg ? "max-w-xl grid-cols-4" : "max-w-md grid-cols-3"}`}>
              <TabsTrigger value="dashboard" className="gap-2">
                <LayoutDashboard className="h-4 w-4" />
                <span className="hidden sm:inline">Dashboard</span>
              </TabsTrigger>
              <TabsTrigger value="trends" className="gap-2">
                <LineChartIcon className="h-4 w-4" />
                <span className="hidden sm:inline">Trends</span>
              </TabsTrigger>
              <TabsTrigger value="tools" className="gap-2">
                <TableProperties className="h-4 w-4" />
                <span className="hidden sm:inline">Tools</span>
              </TabsTrigger>
              {showOrg && (
                <TabsTrigger value="org" className="gap-2">
                  <Network className="h-4 w-4" />
                  <span className="hidden sm:inline">Org</span>
                </TabsTrigger>
              )}
            </TabsList>

            {/* Dashboard */}
            <TabsContent value="dashboard" className="space-y-6">
              <KPICards kpis={data!.kpis} />
              <div className="grid gap-6 lg:grid-cols-2">
                <SpendBreakdownChart tools={data!.tools} />
                <ModelBreakdownChart byModel={data!.byModel} />
              </div>
              <TrendChart trends={data!.trends} />
            </TabsContent>

            {/* Trends */}
            <TabsContent value="trends" className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-2">
                <TrendChart trends={data!.trends} />
                <ForecastChart forecast={data!.forecast} />
              </div>
              <div className="grid gap-6 lg:grid-cols-2">
                <SpendBreakdownChart tools={data!.tools} />
                <ModelBreakdownChart byModel={data!.byModel} />
              </div>
            </TabsContent>

            {/* Tools */}
            <TabsContent value="tools" className="space-y-6">
              <KPICards kpis={data!.kpis} />
              <ToolsTable tools={data!.tools} />
            </TabsContent>

            {/* Org: department / team / person / API key drill-down */}
            {showOrg && (
              <TabsContent value="org" className="space-y-6">
                <KPICards kpis={data!.kpis} />
                <OrgView data={breakdown!} onNavigate={(f) => navigate({ filters: f, view: "org" })} />
              </TabsContent>
            )}
          </Tabs>
        )}
      </main>

      <footer className="border-t border-border/50 py-6">
        <div className="mx-auto flex max-w-7xl items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground sm:px-6 lg:px-8">
          <LiatrioMark className="h-4 opacity-70" />
          <span>AI Cost Dashboard · Liatrio</span>
        </div>
      </footer>
    </div>
  )
}
