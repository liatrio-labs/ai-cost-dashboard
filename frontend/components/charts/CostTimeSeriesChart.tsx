"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AreaChart } from "@tremor/react"
import { Skeleton } from "@/components/ui/skeleton"

interface CostDataPoint {
  date: string
  OpenAI?: number
  Anthropic?: number
  ChatGPT?: number
}

interface CostTimeSeriesChartProps {
  data: CostDataPoint[]
  loading?: boolean
}

export function CostTimeSeriesChart({ data, loading = false }: CostTimeSeriesChartProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost Trends</CardTitle>
          <CardDescription>Daily costs by provider</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-80 w-full" />
        </CardContent>
      </Card>
    )
  }

  const valueFormatter = (value: number) => `$${value.toFixed(2)}`

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost Trends</CardTitle>
        <CardDescription>Daily costs by provider over time</CardDescription>
      </CardHeader>
      <CardContent>
        <AreaChart
          className="h-80"
          data={data}
          index="date"
          categories={["OpenAI", "Anthropic", "ChatGPT"]}
          colors={["emerald", "blue", "violet"]}
          valueFormatter={valueFormatter}
          showLegend={true}
          showGridLines={true}
          curveType="natural"
          stack={true}
        />
      </CardContent>
    </Card>
  )
}
