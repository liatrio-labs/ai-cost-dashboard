"use client"

/**
 * Per-provider sync freshness badges plus missed-cron / manual-entry warnings
 * (issue #47). Reads GET /api/dashboard/freshness; state logic lives in
 * lib/sync-freshness.ts. Times are shown in America/Chicago.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle, CheckCircle2, Clock, PencilLine } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  formatChicago,
  freshnessDetail,
  freshnessLabel,
  type ProviderFreshness,
} from "@/lib/sync-freshness"

interface FreshnessResponse {
  asOf: string
  providers: ProviderFreshness[]
}

function badgeTone(f: ProviderFreshness): string {
  if (f.warning) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  if (f.state === "manual_ok") return "border-border bg-muted/50 text-muted-foreground"
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
}

function BadgeIcon({ f }: { f: ProviderFreshness }) {
  if (f.warning) return <AlertTriangle className="h-3 w-3" aria-hidden />
  if (f.state === "manual_ok") return <PencilLine className="h-3 w-3" aria-hidden />
  return <CheckCircle2 className="h-3 w-3" aria-hidden />
}

export function SyncFreshnessView({
  data,
  isAdmin = false,
  className,
}: {
  data: FreshnessResponse
  isAdmin?: boolean
  className?: string
}) {
  const now = new Date(data.asOf)
  const warnings = data.providers.filter((f) => f.warning)
  if (!data.providers.length) return null
  return (
    <section aria-label="Sync status" className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Clock className="h-3 w-3" aria-hidden />
          Sync status (CT)
        </span>
        {data.providers.map((f) => (
          <span
            key={f.id}
            data-state={f.state}
            title={freshnessDetail(f, now)}
            className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium", badgeTone(f))}
          >
            <BadgeIcon f={f} />
            <span>{f.name}</span>
            <span className="font-normal opacity-80">
              {freshnessLabel(f, now)}
              {f.lastSyncedAt && f.state !== "manual_missing" ? ` · ${formatChicago(f.lastSyncedAt)}` : ""}
            </span>
          </span>
        ))}
      </div>
      {warnings.length > 0 && (
        <div
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
        >
          <ul className="space-y-0.5">
            {warnings.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  {freshnessDetail(f, now)}
                  {isAdmin && f.state === "manual_missing" && (
                    <>
                      {" "}
                      <Link href="/admin" className="underline underline-offset-2">
                        Open Admin
                      </Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Fetches freshness and renders it; renders nothing on error (non-fatal). */
export function SyncFreshness({ isAdmin = false, className }: { isAdmin?: boolean; className?: string }) {
  const [data, setData] = useState<FreshnessResponse | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch("/api/dashboard/freshness")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: FreshnessResponse | null) => {
        if (!cancelled) setData(d && Array.isArray(d.providers) ? d : null)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  if (!data) return null
  return <SyncFreshnessView data={data} isAdmin={isAdmin} className={className} />
}
