"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
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
import { OrgBreakdown, OrgFilterBar } from "@/components/org/org-breakdown"
import { ToolProductCards } from "@/components/claude-ai-products"
import { CursorCycleSpendCard } from "@/components/cursor-cycle-spend"
import type { CursorCycleView } from "@/lib/cursor-spend"
import { formatMonthLong, formatRangeLabel, type DashboardData } from "@/lib/dashboard-types"
import {
  hasFilters,
  hasOrgFilters,
  parseFilters,
  toQueryString,
  type DashboardFilters,
} from "@/lib/dashboard-filters"
import type { BreakdownData } from "@/lib/org/breakdown"

type PeriodQuery =
  | { mode: "month"; month: string }
  | { mode: "range"; start: string; end: string }
  | null // null = default (current month)

const TABS = ["dashboard", "trends", "tools", "org"] as const
type Tab = (typeof TABS)[number]

function periodFromParams(sp: URLSearchParams): PeriodQuery {
  const start = sp.get("start")
  const end = sp.get("end")
  if (start && end) return { mode: "range", start, end }
  const month = sp.get("month")
  return month ? { mode: "month", month } : null
}

function periodParams(q: PeriodQuery): Record<string, string | null> {
  if (q?.mode === "month") return { month: q.month }
  if (q?.mode === "range") return { start: q.start, end: q.end }
  return {}
}

export function DashboardClient({ isAdmin = false }: { isAdmin?: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [data, setData] = useState<DashboardData | null>(null)
  const [breakdown, setBreakdown] = useState<BreakdownData | null>(null)
  // Issue #76: Cursor billing-cycle on-demand (optional; hidden if it fails).
  const [cursorCycle, setCursorCycle] = useState<CursorCycleView | null>(null)

  // Period, filters and tab live in the URL (issue #8), so views are shareable.
  const spKey = searchParams.toString()
  const { query, filters, tab, apiQs } = useMemo(() => {
    const sp = new URLSearchParams(spKey)
    const query = periodFromParams(sp)
    const filters = parseFilters(sp)
    const t = sp.get("tab") as Tab | null
    const tab: Tab = t && TABS.includes(t) ? t : "dashboard"
    return { query, filters, tab, apiQs: toQueryString(periodParams(query), filters) }
  }, [spKey])

  const navigate = useCallback(
    (next: { query?: PeriodQuery; filters?: DashboardFilters; tab?: Tab }) => {
      const sp = new URLSearchParams(toQueryString(periodParams(next.query !== undefined ? next.query : query), next.filters ?? filters))
      const t = next.tab ?? tab
      if (t !== "dashboard") sp.set("tab", t)
      const qs = sp.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname, query, filters, tab]
  )
  const setQuery = (q: PeriodQuery) => navigate({ query: q })
  const setFilters = (f: DashboardFilters) => navigate({ filters: f })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rangeOpen, setRangeOpen] = useState(false)
  const [draftFrom, setDraftFrom] = useState("")
  const [draftTo, setDraftTo] = useState("")

  const loadData = useCallback(
    async (apiQs: string) => {
      setError(null)
      const qs = apiQs ? `?${apiQs}` : ""
      // The org breakdown is optional: if it fails, the dashboard renders as before.
      fetch(`/api/dashboard/breakdown${qs}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: BreakdownData | null) => setBreakdown(b))
        .catch(() => setBreakdown(null))
      fetch("/api/dashboard/cursor-cycle")
        .then((r) => (r.ok ? r.json() : null))
        .then((v: CursorCycleView | null) => setCursorCycle(v))
        .catch(() => setCursorCycle(null))
      try {
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
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard data")
      } finally {
        setLoading(false)
      }
    },
    [router]
  )

  // Load on mount and whenever the period or filters change.
  useEffect(() => {
    loadData(apiQs)
  }, [apiQs, loadData])

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
  const hasAnyData = !!data && data.months.length > 0
  const hasPeriodData = !!data && data.tools.length > 0
  // Org views appear once an org structure exists (or a shared link carries
  // filters); otherwise the dashboard looks exactly as it did before #8.
  const showOrg = filtered || !!breakdown?.orgConfigured
  // Issue #76: the Cursor cycle card is team-wide, so it shows without org
  // filters and only when the provider filter is empty or Cursor.
  const showCursorCycle = !hasOrgFilters(filters) && (!filters.provider || filters.provider === "cursor")
  const activeTab: Tab = tab === "org" && !showOrg ? "dashboard" : tab
  // Name of the team/department whose forecast the chart shows (issue #9).
  const forecastUnit = data?.forecastMeta?.unit
  const forecastUnitLabel = forecastUnit
    ? forecastUnit.unassigned
      ? "Unassigned"
      : (forecastUnit.level === "team" ? breakdown?.options.teams : breakdown?.options.departments)?.find(
          (o) => o.id === forecastUnit.key
        )?.label
    : undefined

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <LiatrioMark className="h-8" />
            <div>
              <h1 className="text-lg font-semibold text-foreground">AI Spend Dashboard</h1>
              {data && (data.months.length > 0 || filtered) && (
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-3 w-3 text-muted-foreground" />
                  {/* Month dropdown (defaults to the current month) */}
                  <Select
                    value={data.period.mode === "month" ? data.selectedMonth ?? "" : ""}
                    onValueChange={(value) => setQuery({ mode: "month", month: value })}
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
                            setQuery({ mode: "range", start, end })
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

        {showOrg && (
          <div className="mb-6">
            <OrgFilterBar data={breakdown} filters={filters} onFiltersChange={setFilters} />
          </div>
        )}

        {filtered && !hasPeriodData ? (
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="rounded-full bg-muted p-4">
                <Inbox className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">No spend matches these filters</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Try another period, or clear the filters.
              </p>
              <Button variant="outline" size="sm" onClick={() => setFilters({})}>
                Clear filters
              </Button>
            </CardContent>
          </Card>
        ) : !hasAnyData ? (
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
                There&apos;s no recorded spend for the selected period. Pick another
                month or range above.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(v) => navigate({ tab: v as Tab })}
            className="space-y-6"
          >
            <TabsList className={`grid w-full max-w-md ${showOrg ? "grid-cols-4" : "grid-cols-3"}`}>
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
              <KPICards kpis={data!.kpis} projection={data!.projection} />
              <div className="grid gap-6 lg:grid-cols-2">
                <SpendBreakdownChart tools={data!.tools} total={data!.kpis.totalSpend} />
                <ModelBreakdownChart byModel={data!.byModel} />
              </div>
              {/* Issue #48 / #65: Claude.ai and Cursor by product, summing to their tool rows. */}
              <ToolProductCards tools={data!.tools} />
              {/* Issue #76: billing-cycle (not calendar-month) Cursor on-demand; team-wide, so only unfiltered or Cursor-only views. */}
              {cursorCycle && showCursorCycle && <CursorCycleSpendCard view={cursorCycle} />}
              <TrendChart trends={data!.trends} currentMonth={data!.projection?.currentMonth} />
            </TabsContent>

            {/* Trends */}
            <TabsContent value="trends" className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-2">
                <TrendChart trends={data!.trends} currentMonth={data!.projection?.currentMonth} />
                <ForecastChart
                  forecast={data!.forecast}
                  meta={data!.forecastMeta}
                  unitLabel={forecastUnitLabel}
                  currentMonth={data!.projection?.currentMonth}
                />
              </div>
              <div className="grid gap-6 lg:grid-cols-2">
                <SpendBreakdownChart tools={data!.tools} total={data!.kpis.totalSpend} />
                <ModelBreakdownChart byModel={data!.byModel} />
              </div>
            </TabsContent>

            {/* Tools */}
            <TabsContent value="tools" className="space-y-6">
              <KPICards kpis={data!.kpis} projection={data!.projection} />
              <ToolsTable tools={data!.tools} projection={data!.projection} />
            </TabsContent>

            {/* Org: department / team / person / API key drill-downs */}
            {showOrg && (
              <TabsContent value="org" className="space-y-6">
                {breakdown ? (
                  <OrgBreakdown data={breakdown} onFiltersChange={setFilters} />
                ) : (
                  <div className="flex justify-center py-12">
                    <Spinner className="h-6 w-6" />
                  </div>
                )}
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
