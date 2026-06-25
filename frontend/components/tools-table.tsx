"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TrendingUp, TrendingDown, Minus, Search, ExternalLink } from "lucide-react"
import { formatCurrency, type DashboardTool } from "@/lib/dashboard-types"

interface ToolsTableProps {
  tools: DashboardTool[]
}

export function ToolsTable({ tools }: ToolsTableProps) {
  const [searchTerm, setSearchTerm] = useState("")

  const filteredTools = tools.filter(
    (tool) =>
      tool.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tool.subscriptionType.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const getTrendIcon = (direction: string) => {
    switch (direction) {
      case "up":
        return <TrendingUp className="h-4 w-4 text-emerald-500" />
      case "down":
        return <TrendingDown className="h-4 w-4 text-red-500" />
      default:
        return <Minus className="h-4 w-4 text-muted-foreground" />
    }
  }

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">Providers</CardTitle>
        <CardDescription>Spend by provider for the selected month</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search providers..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <div className="rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Provider</TableHead>
                <TableHead className="hidden lg:table-cell">Type</TableHead>
                <TableHead>Monthly Spend</TableHead>
                <TableHead className="hidden md:table-cell">Usage</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTools.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No providers with spend for this month.
                  </TableCell>
                </TableRow>
              ) : (
                filteredTools.map((tool) => (
                  <TableRow key={tool.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: tool.color }}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{tool.name}</span>
                            {tool.adminUrl ? (
                              <a
                                href={tool.adminUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open platform admin"
                                className="text-muted-foreground hover:text-primary"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : null}
                          </div>
                          {tool.description ? (
                            <p className="max-w-[28ch] truncate text-xs text-muted-foreground">
                              {tool.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Badge variant="secondary">{tool.subscriptionType}</Badge>
                    </TableCell>
                    <TableCell className="font-mono">{formatCurrency(tool.monthlySpend)}</TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {tool.usageVolume}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {getTrendIcon(tool.changeDirection)}
                        <span
                          className={
                            tool.changeDirection === "up"
                              ? "text-emerald-500"
                              : tool.changeDirection === "down"
                                ? "text-red-500"
                                : "text-muted-foreground"
                          }
                        >
                          {tool.changeDirection === "stable" ? "—" : `${tool.changePercent}%`}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
