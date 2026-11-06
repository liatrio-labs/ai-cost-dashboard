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
import { LowConfidenceMark } from "@/components/kpi-cards"
import {
  forecastDescription,
  isLowConfidence,
  lowConfidenceNote,
  formatCurrency,
  type CurrentMonthProjection,
  type DashboardForecast,
  type DashboardForecastMeta,
} from "@/lib/dashboard-types"
import { forecastSeries, type ChartPoint } from "@/lib/chart-series"

interface ForecastChartProps {
  forecast: DashboardForecast[]
  meta?: DashboardForecastMeta
  /** Display name of the filtered team/department (issue #9). */
  unitLabel?: string
  /** Issue #39: the projected current month (person/key/project views describe it). */
  currentMonth?: CurrentMonthProjection | null
}

const ACTUAL_COLOR = "#24AE1D" // Liatrio Primary Green
const PROJECTED_COLOR = "#C068F9" // Liatrio Violet

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ value: number; dataKey: string; payload: ChartPoint }>
  label?: string
}) {
  if (active && payload && payload.length) {
    const point = payload.find((p) => p.value != null)
    if (!point) return null
    // The last actual month is on both lines; report it as actual.
    const isProjected = point.payload.actual === null
    const value = isProjected ? point.payload.projected! : point.payload.actual!
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
          {formatCurrency(value)}
        </p>
        {isProjected && point.payload.actualToDate !== undefined && (
          <p className="text-xs text-muted-foreground">Actual to date {formatCurrency(point.payload.actualToDate)}</p>
        )}
      </div>
    )
  }
  return null
}

export function ForecastChart({ forecast, meta, unitLabel, currentMonth }: ForecastChartProps) {
  const rows = forecast || []
  // Actual line through the last complete month; the projected line starts
  // there (lib/chart-series.ts).
  const chartData = forecastSeries(rows)

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">Spend Forecast</CardTitle>
        <CardDescription>
          {forecastDescription(meta, unitLabel, rows.some((r) => r.projected), currentMonth)}
          {/* Issue #88: an early-month projected point rests on few complete days. */}
          {currentMonth && isLowConfidence(currentMonth) && (
            <span className="ml-1" title={lowConfidenceNote(currentMonth)}>
              <LowConfidenceMark />
            </span>
          )}
        </CardDescription>
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
