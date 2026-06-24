"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  LayoutDashboard,
  LineChart as LineChartIcon,
  TableProperties,
  PlusCircle,
  CalendarDays,
  Inbox,
} from "lucide-react"

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

import { KPICards } from "@/components/kpi-cards"
import { SpendBreakdownChart } from "@/components/spend-breakdown-chart"
import { TrendChart } from "@/components/trend-chart"
import { ForecastChart } from "@/components/forecast-chart"
import { ModelBreakdownChart } from "@/components/model-breakdown-chart"
import { ToolsTable } from "@/components/tools-table"
import { MonthlyEntryForm } from "@/components/monthly-entry-form"
import { formatMonthLong, type DashboardData } from "@/lib/dashboard-types"

export function DashboardClient() {
  const router = useRouter()
  const [data, setData] = useState<DashboardData | null>(null)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(
    async (month: string | null) => {
      setError(null)
      try {
        const qs = month ? `?month=${encodeURIComponent(month)}` : ""
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
        // Sync the selected month to whatever the API resolved.
        setSelectedMonth((prev) => prev ?? json.selectedMonth ?? null)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard data")
      } finally {
        setLoading(false)
      }
    },
    [router]
  )

  // Initial load.
  useEffect(() => {
    loadData(null)
  }, [loadData])

  // Re-fetch when the user picks a different month.
  useEffect(() => {
    if (selectedMonth) {
      loadData(selectedMonth)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth])

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

  const hasData = !!data && data.months.length > 0 && data.tools.length > 0

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-lg font-semibold text-foreground">AI Spend Dashboard</h1>
              {data && data.months.length > 0 && (
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-3 w-3 text-muted-foreground" />
                  <Select
                    value={selectedMonth || data.selectedMonth}
                    onValueChange={(value) => setSelectedMonth(value)}
                  >
                    <SelectTrigger className="h-6 w-auto gap-1 border-0 bg-transparent p-0 text-xs text-muted-foreground hover:text-foreground focus:ring-0">
                      <SelectValue placeholder="Select month" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.months.map((month) => (
                        <SelectItem key={month} value={month}>
                          {formatMonthLong(month)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
          <Link href="/dashboard/chatgpt">
            <Button variant="ghost" size="sm">
              ChatGPT entries
            </Button>
          </Link>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {error && (
          <div className="mb-6 rounded-md bg-destructive/10 p-4 text-destructive">{error}</div>
        )}

        {!hasData ? (
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="rounded-full bg-muted p-4">
                <Inbox className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">No spend data yet</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Once the collectors run, your AI spend will appear here. You can also add a manual
                entry below for providers without an API.
              </p>
              <div className="mt-4 w-full max-w-lg text-left">
                <MonthlyEntryForm onSaveSuccess={() => loadData(selectedMonth)} />
              </div>
            </CardContent>
          </Card>
        ) : (
          <Tabs defaultValue="dashboard" className="space-y-6">
            <TabsList className="grid w-full max-w-lg grid-cols-4">
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
              <TabsTrigger value="entry" className="gap-2">
                <PlusCircle className="h-4 w-4" />
                <span className="hidden sm:inline">Entry</span>
              </TabsTrigger>
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

            {/* Entry */}
            <TabsContent value="entry" className="space-y-6">
              <MonthlyEntryForm onSaveSuccess={() => loadData(selectedMonth)} />
            </TabsContent>
          </Tabs>
        )}
      </main>

      <footer className="border-t border-border/50 py-6">
        <div className="mx-auto max-w-7xl px-4 text-center text-sm text-muted-foreground sm:px-6 lg:px-8">
          AI Cost Dashboard
        </div>
      </footer>
    </div>
  )
}
