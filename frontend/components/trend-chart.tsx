"use client"

import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { formatCurrency, type CurrentMonthProjection, type DashboardTrend } from "@/lib/dashboard-types"
import { trendSeries, type ChartPoint } from "@/lib/chart-series"

interface TrendChartProps {
  trends: DashboardTrend[]
  /** Issue #39: the current month, projected; drawn dotted instead of as a partial-month drop. */
  currentMonth?: CurrentMonthProjection | null
}

const LINE_COLOR = "#24AE1D" // Liatrio Primary Green
const PROJECTED_COLOR = "#C068F9" // Liatrio Violet (as in Spend Forecast)

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ value: number | null; dataKey: string; payload: ChartPoint }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  const isProjected = point.actual === null && point.projected !== null
  const value = isProjected ? point.projected : point.actual
  if (value === null) return null
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-lg">
      <div className="mb-1 flex items-center gap-2">
        <p className="font-medium text-foreground">{label}</p>
        {isProjected && <span className="rounded bg-primary/20 px-1.5 py-0.5 text-xs text-primary">Projected</span>}
      </div>
      <p className="text-sm font-medium" style={{ color: isProjected ? PROJECTED_COLOR : LINE_COLOR }}>
        {formatCurrency(value)}
      </p>
      {isProjected && point.actualToDate !== undefined && (
        <p className="text-xs text-muted-foreground">Actual to date {formatCurrency(point.actualToDate)}</p>
      )}
    </div>
  )
}

export function TrendChart({ trends, currentMonth }: TrendChartProps) {
  const chartData = trendSeries(trends, currentMonth)

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">Spend Trends</CardTitle>
        <CardDescription>
          {currentMonth ? "Monthly spend (solid) with the current month projected (dotted)" : "Total monthly spend over time"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
            No trend data available yet.
          </div>
        ) : (
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradientTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={LINE_COLOR} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={LINE_COLOR} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="month"
                  stroke="var(--muted-foreground)"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="var(--muted-foreground)"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) =>
                    value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value}`
                  }
                />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone"
                  dataKey="actual"
                  name="Total Spend"
                  stroke={LINE_COLOR}
                  fill="url(#gradientTotal)"
                  strokeWidth={2}
                  connectNulls={false}
                />
                {currentMonth && (
                  <Line
                    type="monotone"
                    dataKey="projected"
                    name="Projected"
                    stroke={PROJECTED_COLOR}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={{ r: 3, fill: PROJECTED_COLOR }}
                    connectNulls={false}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
