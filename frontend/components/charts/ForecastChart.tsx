"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LineChart } from "@tremor/react"
import { Skeleton } from "@/components/ui/skeleton"

interface ForecastDataPoint {
  date: string
  actual?: number
  predicted?: number
  lower_bound?: number
  upper_bound?: number
}

interface ForecastChartProps {
  data: ForecastDataPoint[]
  loading?: boolean
}

export function ForecastChart({ data, loading = false }: ForecastChartProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost Forecast</CardTitle>
          <CardDescription>Predicted costs with confidence intervals</CardDescription>
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
        <CardTitle>Cost Forecast</CardTitle>
        <CardDescription>Historical costs and 30-day predictions</CardDescription>
      </CardHeader>
      <CardContent>
        <LineChart
          className="h-80"
          data={data}
          index="date"
          categories={["actual", "predicted", "lower_bound", "upper_bound"]}
          colors={["blue", "violet", "gray", "gray"]}
          valueFormatter={valueFormatter}
          showLegend={true}
          showGridLines={true}
          curveType="natural"
          connectNulls={true}
        />
      </CardContent>
    </Card>
  )
}
