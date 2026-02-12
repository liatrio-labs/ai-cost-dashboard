"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DonutChart } from "@tremor/react"
import { Skeleton } from "@/components/ui/skeleton"

interface ProviderData {
  name: string
  value: number
}

interface ProviderBreakdownChartProps {
  data: ProviderData[]
  loading?: boolean
}

export function ProviderBreakdownChart({ data, loading = false }: ProviderBreakdownChartProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Provider Breakdown</CardTitle>
          <CardDescription>Cost distribution by provider</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Skeleton className="h-64 w-64 rounded-full" />
        </CardContent>
      </Card>
    )
  }

  const valueFormatter = (value: number) => `$${value.toFixed(2)}`

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider Breakdown</CardTitle>
        <CardDescription>Total cost distribution by provider</CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center">
        <DonutChart
          className="h-64"
          data={data}
          category="value"
          index="name"
          colors={["emerald", "blue", "violet"]}
          valueFormatter={valueFormatter}
          showLabel={true}
        />
      </CardContent>
    </Card>
  )
}
