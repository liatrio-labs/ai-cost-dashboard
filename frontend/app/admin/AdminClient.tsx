"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowLeft, Download, Loader2, CheckCircle2, AlertCircle, FileSpreadsheet } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { MonthlyEntryForm } from "@/components/monthly-entry-form"

const PROVIDERS: { id: string; name: string }[] = [
  { id: "anthropic", name: "Anthropic API (platform.claude.com)" },
  { id: "claude-ai", name: "Claude.ai (Enterprise Analytics)" },
  { id: "openai", name: "OpenAI API (platform.openai.com)" },
  { id: "cursor", name: "Cursor (Admin API)" },
  { id: "vercel", name: "Vercel (Usage API)" },
]

interface PullResult {
  loading?: boolean
  status?: string
  recordsStored?: number
  reason?: string
  error?: string
}

export function AdminClient() {
  const [backfill, setBackfill] = useState(false)
  const [results, setResults] = useState<Record<string, PullResult>>({})

  async function pull(provider: string) {
    setResults((r) => ({ ...r, [provider]: { loading: true } }))
    try {
      const res = await fetch("/api/admin/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, backfill }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResults((r) => ({ ...r, [provider]: { error: body.error || `HTTP ${res.status}` } }))
        return
      }
      setResults((r) => ({
        ...r,
        [provider]: {
          status: body.status,
          recordsStored: body.records_stored ?? 0,
          reason: body.reason,
          error: body.error,
        },
      }))
    } catch (e: any) {
      setResults((r) => ({ ...r, [provider]: { error: e?.message || "Request failed" } }))
    }
  }

  async function pullAll() {
    for (const p of PROVIDERS) {
      // sequential so the backend isn't hammered all at once
      // eslint-disable-next-line no-await-in-loop
      await pull(p.id)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <h1 className="text-lg font-semibold">Admin · Data ingest</h1>
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Back to dashboard
            </Button>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
        {/* Pull data */}
        <Card>
          <CardHeader>
            <CardTitle>Pull data from providers</CardTitle>
            <CardDescription>
              Trigger collection on demand. Daily collection also runs automatically.
              Enable backfill to pull the last 90 days.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-md border border-border/50 p-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={backfill}
                  onChange={(e) => setBackfill(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                Backfill last 90 days
              </label>
              <Button onClick={pullAll} className="gap-2">
                <Download className="h-4 w-4" />
                Pull all
              </Button>
            </div>

            <div className="divide-y divide-border/50">
              {PROVIDERS.map((p) => {
                const r = results[p.id]
                return (
                  <div key={p.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      {r && !r.loading && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          {r.error ? (
                            <>
                              <AlertCircle className="h-3 w-3 text-destructive" />
                              <span className="text-destructive">{r.error}</span>
                            </>
                          ) : r.status === "skipped" ? (
                            <>
                              <AlertCircle className="h-3 w-3 text-amber-500" />
                              {r.reason || "Skipped (no API key set)"}
                            </>
                          ) : r.status === "error" ? (
                            <>
                              <AlertCircle className="h-3 w-3 text-destructive" />
                              <span className="text-destructive">{r.error || "Error"}</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="h-3 w-3 text-primary" />
                              Stored {r.recordsStored} record{r.recordsStored === 1 ? "" : "s"}
                            </>
                          )}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => pull(p.id)}
                      disabled={r?.loading}
                      className="gap-2"
                    >
                      {r?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      Pull
                    </Button>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Manual entry */}
        <Card>
          <CardHeader>
            <CardTitle>Manual entry</CardTitle>
            <CardDescription>
              Add a cost entry for a provider without an API (e.g. ChatGPT), or correct a figure.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <MonthlyEntryForm onSaveSuccess={() => { /* admin stays on page */ }} />
            <Separator />
            <Link href="/dashboard/chatgpt">
              <Button variant="ghost" size="sm" className="gap-2">
                <FileSpreadsheet className="h-4 w-4" />
                ChatGPT CSV import
              </Button>
            </Link>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
