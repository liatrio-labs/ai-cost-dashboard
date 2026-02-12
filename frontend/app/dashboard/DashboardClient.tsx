"use client"

import { useState } from "react"
import { DateRange } from "react-day-picker"
import { subDays } from "date-fns"
import { DollarSign, TrendingUp, Calendar, Sparkles } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { MetricsCard } from "@/components/dashboard/MetricsCard"
import { DateRangePicker } from "@/components/dashboard/DateRangePicker"
import { CostTimeSeriesChart } from "@/components/charts/CostTimeSeriesChart"
import { ProviderBreakdownChart } from "@/components/charts/ProviderBreakdownChart"
import { ForecastChart } from "@/components/charts/ForecastChart"
import { RecentActivityTable } from "@/components/dashboard/RecentActivityTable"

// Mock data - will be replaced with real API calls
const generateMockTimeSeriesData = () => {
  const data = []
  for (let i = 30; i >= 0; i--) {
    const date = new Date()
    date.setDate(date.getDate() - i)
    data.push({
      date: date.toISOString().split("T")[0],
      OpenAI: Math.random() * 50 + 20,
      Anthropic: Math.random() * 30 + 10,
      ChatGPT: Math.random() * 20 + 5,
    })
  }
  return data
}

const generateMockForecastData = () => {
  const data = []
  // Historical data
  for (let i = 30; i >= 0; i--) {
    const date = new Date()
    date.setDate(date.getDate() - i)
    data.push({
      date: date.toISOString().split("T")[0],
      actual: Math.random() * 100 + 50,
    })
  }
  // Forecast data
  for (let i = 1; i <= 30; i++) {
    const date = new Date()
    date.setDate(date.getDate() + i)
    const predicted = Math.random() * 120 + 60
    data.push({
      date: date.toISOString().split("T")[0],
      predicted,
      lower_bound: predicted * 0.8,
      upper_bound: predicted * 1.2,
    })
  }
  return data
}

const mockProviderData = [
  { name: "OpenAI", value: 1250.45 },
  { name: "Anthropic", value: 850.30 },
  { name: "ChatGPT", value: 425.15 },
]

const mockRecentActivity = [
  {
    id: "1",
    timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    provider: "OpenAI",
    model: "gpt-4",
    cost: 0.0324,
    tokens: 1580,
  },
  {
    id: "2",
    timestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    provider: "Anthropic",
    model: "claude-3-opus",
    cost: 0.0456,
    tokens: 2100,
  },
  {
    id: "3",
    timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    provider: "ChatGPT",
    model: "gpt-3.5-turbo",
    cost: 0.0012,
    tokens: 450,
  },
  {
    id: "4",
    timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    provider: "OpenAI",
    model: "gpt-4-turbo",
    cost: 0.0289,
    tokens: 1420,
  },
  {
    id: "5",
    timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    provider: "Anthropic",
    model: "claude-3-sonnet",
    cost: 0.0234,
    tokens: 1680,
  },
]

export function DashboardClient() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: subDays(new Date(), 30),
    to: new Date(),
  })

  const timeSeriesData = generateMockTimeSeriesData()
  const forecastData = generateMockForecastData()

  return (
    <div className="container mx-auto py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Track your AI API costs and forecasts
          </p>
        </div>
        <div className="flex gap-2">
          <DateRangePicker date={dateRange} onDateChange={setDateRange} />
          <Link href="/settings">
            <Button>Settings</Button>
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricsCard
          title="This Month"
          value="$2,525.90"
          change={12.5}
          changeLabel="from last month"
          icon={<DollarSign className="h-4 w-4 text-muted-foreground" />}
        />
        <MetricsCard
          title="Yesterday"
          value="$87.34"
          change={-5.2}
          changeLabel="from previous day"
          icon={<Calendar className="h-4 w-4 text-muted-foreground" />}
        />
        <MetricsCard
          title="30-Day Forecast"
          value="$3,124.50"
          change={8.3}
          changeLabel="projected growth"
          icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
        />
        <MetricsCard
          title="Top Model"
          value="GPT-4"
          icon={<Sparkles className="h-4 w-4 text-muted-foreground" />}
        />
      </div>

      {/* Charts Grid */}
      <div className="grid gap-6 md:grid-cols-2">
        <CostTimeSeriesChart data={timeSeriesData} />
        <ProviderBreakdownChart data={mockProviderData} />
      </div>

      {/* Forecast Chart */}
      <ForecastChart data={forecastData} />

      {/* Recent Activity */}
      <RecentActivityTable activities={mockRecentActivity} />
    </div>
  )
}
