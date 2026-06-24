"use client"

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { formatCurrency, formatMonthLabel, type DashboardForecast } from "@/lib/dashboard-types"

interface ForecastChartProps {
  forecast: DashboardForecast[]
}

const ACTUAL_COLOR = "#00A94F"
const PROJECTED_COLOR = "#8B5CF6"

export function ForecastChart({ forecast }: ForecastChartProps) {
  const rows = forecast || []

  // Find the index of the last historical (non-projected) point so the
  // projected series can start there, keeping the line visually continuous.
  const lastActualIndex = rows.reduce(
    (acc, r, i) => (!r.projected ? i : acc),
    -1
  )

  const chartData = rows.map((r, i) => ({
    month: formatMonthLabel(r.month),
    // actual line: only historical points (plus a null tail)
    actual: !r.projected ? r.total : null,
    // projected line: starts at the last actual point, then projected points
    projected: r.projected || i === lastActualIndex ? r.total : null,
  }))

  const CustomTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean
    payload?: Array<{ value: number; dataKey: string }>
    label?: string
  }) => {
    if (active && payload && payload.length) {
      const point = payload.find((p) => p.value != null)
      if (!point) return null
      const isProjected = point.dataKey === "projected"
      return (
        <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-lg">
          <div className="flex items-center gap-2">
            <p className="font-medium text-foreground">{label}</p>
            {isProjected && (
              <span className="rounded bg-primary/20 px-1.5 py-0.5 text-xs text-primary">
                Projected
              </span>
            )}
          </div>
          <p
            className="mt-1 text-lg font-bold"
            style={{ color: isProjected ? PROJECTED_COLOR : ACTUAL_COLOR }}
          >
            {formatCurrency(point.value)}
          </p>
        </div>
      )
    }
    return null
  }

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">Spend Forecast</CardTitle>
        <CardDescription>History (solid) with trend projection (dashed)</CardDescription>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
            Not enough history to forecast yet.
          </div>
        ) : (
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
                <Legend
                  verticalAlign="bottom"
                  height={36}
                  wrapperStyle={{ paddingTop: "10px" }}
                  formatter={(value) => (
                    <span className="text-sm text-muted-foreground">{value}</span>
                  )}
                />
                <Line
                  type="monotone"
                  dataKey="actual"
                  name="Actual"
                  stroke={ACTUAL_COLOR}
                  strokeWidth={2}
                  dot={{ r: 3, fill: ACTUAL_COLOR }}
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="projected"
                  name="Projected"
                  stroke={PROJECTED_COLOR}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={{ r: 3, fill: PROJECTED_COLOR }}
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
