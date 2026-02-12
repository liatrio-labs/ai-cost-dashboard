"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDistanceToNow } from "date-fns"

interface Activity {
  id: string
  timestamp: string
  provider: string
  model: string
  cost: number
  tokens?: number
}

interface RecentActivityTableProps {
  activities: Activity[]
  loading?: boolean
}

const providerColors: Record<string, "default" | "secondary" | "outline"> = {
  OpenAI: "default",
  Anthropic: "secondary",
  ChatGPT: "outline",
}

export function RecentActivityTable({ activities, loading = false }: RecentActivityTableProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest API usage across providers</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (activities.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest API usage across providers</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No recent activity. Start using your API keys to see data here.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
        <CardDescription>Latest API usage across providers</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activities.map((activity) => (
              <TableRow key={activity.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDistanceToNow(new Date(activity.timestamp), { addSuffix: true })}
                </TableCell>
                <TableCell>
                  <Badge variant={providerColors[activity.provider] || "default"}>
                    {activity.provider}
                  </Badge>
                </TableCell>
                <TableCell className="font-medium">{activity.model}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {activity.tokens ? activity.tokens.toLocaleString() : "-"}
                </TableCell>
                <TableCell className="text-right font-medium">
                  ${activity.cost.toFixed(4)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
