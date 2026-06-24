"use client"

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { formatCurrency, type DashboardTool } from "@/lib/dashboard-types"

interface SpendBreakdownChartProps {
  tools: DashboardTool[]
}

export function SpendBreakdownChart({ tools }: SpendBreakdownChartProps) {
  const data = tools
    .filter((t) => t.monthlySpend > 0)
    .map((tool) => ({
      name: tool.name,
      value: tool.monthlySpend,
      color: tool.color,
    }))

  const total = data.reduce((sum, t) => sum + t.value, 0)

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?: boolean
    payload?: Array<{ name: string; value: number }>
  }) => {
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
                  <Tooltip content={<CustomTooltip />} />
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
              <p className="text-3xl font-bold text-foreground">{formatCurrency(total)}</p>
              <p className="text-sm text-muted-foreground">Total Monthly Spend</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
