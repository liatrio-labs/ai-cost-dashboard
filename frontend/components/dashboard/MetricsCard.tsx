import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { TrendingUp, TrendingDown } from "lucide-react"

interface MetricsCardProps {
  title: string
  value: string | number
  change?: number
  changeLabel?: string
  icon?: React.ReactNode
  loading?: boolean
}

export function MetricsCard({
  title,
  value,
  change,
  changeLabel,
  icon,
  loading = false,
}: MetricsCardProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          {icon}
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-24 mb-2" />
          <Skeleton className="h-4 w-32" />
        </CardContent>
      </Card>
    )
  }

  const isPositive = change !== undefined && change > 0
  const isNegative = change !== undefined && change < 0

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {change !== undefined && (
          <p className="text-xs text-muted-foreground flex items-center mt-1">
            {isPositive && <TrendingUp className="mr-1 h-3 w-3 text-red-500" />}
            {isNegative && <TrendingDown className="mr-1 h-3 w-3 text-green-500" />}
            <span className={isPositive ? "text-red-500" : isNegative ? "text-green-500" : ""}>
              {Math.abs(change).toFixed(1)}%
            </span>
            {changeLabel && <span className="ml-1">{changeLabel}</span>}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
