"use client"

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { formatCurrency, type DashboardByModel, type DashboardLicense } from "@/lib/dashboard-types"

interface ModelBreakdownChartProps {
  byModel: DashboardByModel[]
}

function ModelTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ value: number; payload: { name: string; color: string } }>
}) {
  if (active && payload && payload.length) {
    const item = payload[0]
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
        <p className="font-medium text-foreground">{item.payload.name}</p>
        <p className="text-lg font-bold" style={{ color: item.payload.color }}>
          {formatCurrency(item.value)}
        </p>
      </div>
    )
  }
  return null
}

export function ModelBreakdownChart({ byModel }: ModelBreakdownChartProps) {
  const data = (byModel || [])
    .filter((m) => m.total > 0)
    .map((m) => ({ name: m.model, value: m.total, color: m.color }))

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">Spend by Model</CardTitle>
        <CardDescription>
          Top models by usage for the selected period. Seat fees and subscriptions are under Seats and licenses.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
            No model-level spend recorded for this month.
          </div>
        ) : (
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis
                  type="number"
                  stroke="var(--muted-foreground)"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) =>
                    value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value}`
                  }
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  stroke="var(--muted-foreground)"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  width={120}
                />
                <Tooltip content={<ModelTooltip />} cursor={{ fill: "var(--muted)", opacity: 0.3 }} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {data.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Issue #88: seat fees, subscriptions and invoice adjustments ("Claude Ultra
 * seats", "Cursor seats") are licenses, not models, so they get their own
 * labelled list instead of dominating Spend by Model.
 */
export function SeatsLicensesChart({ licenses }: { licenses: DashboardLicense[] }) {
  const rows = (licenses || []).filter((l) => l.total !== 0)
  if (rows.length === 0) return null
  const max = Math.max(...rows.map((l) => Math.abs(l.total)))
  const total = Math.round(rows.reduce((s, l) => s + l.total, 0) * 100) / 100
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur" data-testid="seats-licenses">
      <CardHeader>
        <CardTitle className="text-lg">Seats and licenses</CardTitle>
        <CardDescription>
          Seat fees, subscriptions and invoice adjustments for the selected period ({formatCurrency(total)}). Not model usage.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {rows.map((l) => (
            <li key={`${l.kind}:${l.provider}`} data-testid="license-row" className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{l.label}</span>
                <span className="font-mono tabular-nums">{formatCurrency(l.total)}</span>
              </div>
              <div className="h-2 rounded bg-muted">
                <div
                  className="h-2 rounded"
                  style={{ width: `${max > 0 ? Math.max(2, (Math.abs(l.total) / max) * 100) : 0}%`, backgroundColor: l.color }}
                />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
