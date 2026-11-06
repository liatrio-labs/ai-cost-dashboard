"use client"

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { formatCurrency, type DashboardTool } from "@/lib/dashboard-types"

interface SpendBreakdownChartProps {
  tools: DashboardTool[]
  /**
   * Issue #88: the headline total (kpis.totalSpend). The donut shows this
   * figure so it matches the headline to the cent; summing per-provider
   * rounded amounts can drift by a cent or more.
   */
  total?: number
}

/** The donut's center total: the headline figure when given, else the sum of the slices. */
export function donutTotal(tools: Pick<DashboardTool, "monthlySpend">[], headline?: number): number {
  if (headline !== undefined && Number.isFinite(headline)) return headline
  return Math.round(tools.filter((t) => t.monthlySpend > 0).reduce((sum, t) => sum + t.monthlySpend, 0) * 100) / 100
}

function SpendTooltip({
  active,
  payload,
  total,
}: {
  total: number
  active?: boolean
  payload?: Array<{ name: string; value: number }>
}) {
  if (active && payload && payload.length) {
    const item = payload[0]
    const percent = total > 0 ? ((item.value / total) * 100).toFixed(1) : "0"
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
        <p className="font-medium text-foreground">{item.name}</p>
        <p className="text-sm text-muted-foreground">
          {formatCurrency(item.value)} ({percent}%)
        </p>
      </div>
    )
  }
  return null
}

export function SpendBreakdownChart({ tools, total: headline }: SpendBreakdownChartProps) {
  const data = tools
    .filter((t) => t.monthlySpend > 0)
    .map((tool) => ({
      name: tool.name,
      value: tool.monthlySpend,
      color: tool.color,
    }))

  const total = donutTotal(tools, headline)

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">Spend Distribution</CardTitle>
        <CardDescription>Monthly spend by provider</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            No spend recorded for this month.
          </div>
        ) : (
          <>
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                  <Pie
                    data={data}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={85}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {data.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<SpendTooltip total={total} />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              {data.map((entry, index) => (
                <div key={index} className="flex items-center gap-2">
                  <div
                    className="h-3 w-3 flex-shrink-0 rounded-sm"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="truncate text-xs text-muted-foreground">{entry.name}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 text-center">
              <p className="text-3xl font-bold text-foreground" data-testid="donut-total">
                {formatCurrency(total)}
              </p>
              <p className="text-sm text-muted-foreground">Total Monthly Spend</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
