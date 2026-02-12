"use client"

import * as React from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import { Trash2, Edit, Download } from "lucide-react"
import { ManualEntryForm } from "@/components/forms/ManualEntryForm"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"

interface CostRecord {
  id: string
  timestamp: string
  model_name: string
  cost_usd: number
  metadata: {
    notes?: string
    entry_type?: string
  }
  created_at: string
}

export default function ChatGPTPage() {
  const { showToast } = useToast()
  const queryClient = useQueryClient()
  const [chatGptProviderId, setChatGptProviderId] = React.useState<string | null>(null)

  // Fetch ChatGPT provider
  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: async () => {
      const res = await fetch("/api/providers")
      if (!res.ok) throw new Error("Failed to fetch providers")
      return res.json()
    },
  })

  // Set ChatGPT provider ID once loaded
  React.useEffect(() => {
    if (providers) {
      const chatgptProvider = providers.find((p: any) => p.name === "chatgpt")
      if (chatgptProvider) {
        setChatGptProviderId(chatgptProvider.id)
      }
    }
  }, [providers])

  // Fetch manual entries (last 90 days)
  const { data: costRecords, isLoading: isLoadingRecords } = useQuery({
    queryKey: ["cost-records", "chatgpt", chatGptProviderId],
    queryFn: async () => {
      if (!chatGptProviderId) return []

      const endDate = new Date()
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - 90)

      const params = new URLSearchParams({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        providers: chatGptProviderId,
        granularity: "hour",
        limit: "500",
      })

      const res = await fetch(`/api/costs?${params}`)
      if (!res.ok) throw new Error("Failed to fetch cost records")
      const data = await res.json()
      return data.data as CostRecord[]
    },
    enabled: !!chatGptProviderId,
  })

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (recordId: string) => {
      // Note: Delete endpoint would need to be added to API
      // For now, we'll show a toast
      throw new Error("Delete functionality coming soon")
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-records"] })
      showToast("success", "Entry deleted successfully")
    },
    onError: (error: any) => {
      showToast("error", error.message || "Failed to delete entry")
    },
  })

  const handleSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ["cost-records"] })
  }

  const handleDelete = (recordId: string) => {
    if (confirm("Are you sure you want to delete this entry?")) {
      deleteMutation.mutate(recordId)
    }
  }

  const exportToCsv = () => {
    if (!costRecords || costRecords.length === 0) {
      showToast("warning", "No entries to export")
      return
    }

    const csvHeader = "date,cost,model,notes\n"
    const csvRows = costRecords
      .map((record) => {
        const date = format(new Date(record.timestamp), "yyyy-MM-dd")
        const notes = record.metadata?.notes || ""
        return `${date},${record.cost_usd},${record.model_name},"${notes}"`
      })
      .join("\n")

    const csvContent = csvHeader + csvRows
    const blob = new Blob([csvContent], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `chatgpt-costs-${format(new Date(), "yyyy-MM-dd")}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    showToast("success", "Exported to CSV successfully")
  }

  if (!chatGptProviderId) {
    return (
      <div className="container mx-auto py-8 px-4">
        <Alert>
          <AlertDescription>Loading ChatGPT provider...</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-6xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">ChatGPT Cost Tracking</h1>
          <p className="text-muted-foreground">
            Manually track your ChatGPT usage costs. Add individual entries or import from CSV.
          </p>
        </div>

        {/* Info Alert */}
        <Alert>
          <AlertDescription>
            <strong>Note:</strong> ChatGPT doesn't have a public API for cost tracking, so you'll
            need to manually enter your usage costs. You can find your billing information in your{" "}
            <a
              href="https://platform.openai.com/account/usage"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              OpenAI account
            </a>
            .
          </AlertDescription>
        </Alert>

        {/* Manual Entry Form */}
        <ManualEntryForm providerId={chatGptProviderId} onSuccess={handleSuccess} />

        {/* Historical Entries */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Recent Entries</CardTitle>
                <CardDescription>Your manually entered ChatGPT costs (last 90 days)</CardDescription>
              </div>
              {costRecords && costRecords.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportToCsv}
                  aria-label="Export to CSV"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Export CSV
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {isLoadingRecords ? (
              <div className="space-y-3">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : !costRecords || costRecords.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">
                  No entries yet. Add your first ChatGPT cost entry above.
                </p>
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {costRecords.map((record) => (
                      <TableRow key={record.id}>
                        <TableCell className="font-medium">
                          {format(new Date(record.timestamp), "MMM dd, yyyy")}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{record.model_name}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          ${record.cost_usd.toFixed(2)}
                        </TableCell>
                        <TableCell className="max-w-xs truncate">
                          {record.metadata?.notes || "-"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-xs">
                            {record.metadata?.entry_type === "csv_import" ? "CSV" : "Manual"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(record.id)}
                              disabled={deleteMutation.isPending}
                              aria-label={`Delete entry from ${format(new Date(record.timestamp), "MMM dd, yyyy")}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Summary Stats */}
        {costRecords && costRecords.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Total Entries</p>
                  <p className="text-2xl font-bold">{costRecords.length}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Total Cost</p>
                  <p className="text-2xl font-bold">
                    $
                    {costRecords
                      .reduce((sum, record) => sum + record.cost_usd, 0)
                      .toFixed(2)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Average Cost</p>
                  <p className="text-2xl font-bold">
                    $
                    {(
                      costRecords.reduce((sum, record) => sum + record.cost_usd, 0) /
                      costRecords.length
                    ).toFixed(2)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
