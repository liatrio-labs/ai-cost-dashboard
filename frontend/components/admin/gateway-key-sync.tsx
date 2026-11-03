"use client"

/**
 * "Sync keys now" (issues #28, #32). Used on /admin (in the pull card, per
 * provider) and /admin/org ("API keys & projects", both providers). Calls
 * POST /api/admin/org/keys/sync, which registers every Anthropic and Vercel
 * AI Gateway key in org_api_keys (keys with no spend included), assigns keys
 * to their creator where the rules allow, and never overwrites manual
 * assignments. A failed key list is a 502 and nothing is written. Shows the
 * per-provider counts, or the error, inline.
 */

import { useState } from "react"
import { AlertCircle, CheckCircle2, KeyRound, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

export const SYNC_KEYS_URL = "/api/admin/org/keys/sync"

export type KeySyncProvider = "anthropic" | "vercel-ai-gateway"
const PROVIDER_LABEL: Record<KeySyncProvider, string> = { anthropic: "Anthropic", "vercel-ai-gateway": "Vercel AI Gateway" }

export interface GatewaySyncCounts {
  created?: number
  updated?: number
  unchanged?: number
  manual_kept?: number
  keys_listed?: number
  people_created?: number
  projects_created?: number
  unresolved_creators?: number
}

/** "4 keys: 2 created, 1 updated, 1 unchanged, 1 manual kept" plus optional extras. */
export function formatSyncSummary(s: GatewaySyncCounts): string {
  const n = (v: number | undefined) => v ?? 0
  const listed = s.keys_listed ?? n(s.created) + n(s.updated) + n(s.unchanged)
  const parts = [
    `${listed} key${listed === 1 ? "" : "s"}: ${n(s.created)} created, ${n(s.updated)} updated, ${n(s.unchanged)} unchanged, ${n(s.manual_kept)} manual kept`,
  ]
  if (n(s.people_created)) parts.push(`${s.people_created} people created`)
  if (n(s.projects_created)) parts.push(`${s.projects_created} projects created`)
  if (n(s.unresolved_creators)) parts.push(`${s.unresolved_creators} creator${s.unresolved_creators === 1 ? "" : "s"} unresolved (no owner)`)
  return parts.join("; ")
}

export type ProviderSyncResult = GatewaySyncCounts & { status?: string; reason?: string; error?: string }

/** "Anthropic: 4 keys: ...; Vercel AI Gateway: skipped (VERCEL_TOKEN is not configured)". */
export function formatKeySyncResponse(providers: Partial<Record<KeySyncProvider, ProviderSyncResult>>): string {
  return (Object.keys(PROVIDER_LABEL) as KeySyncProvider[])
    .filter((p) => providers[p])
    .map((p) => {
      const r = providers[p]!
      if (r.status === "skipped") return `${PROVIDER_LABEL[p]}: skipped (${r.reason ?? "not configured"})`
      if (r.status === "error") return `${PROVIDER_LABEL[p]}: failed (${r.error ?? "error"})`
      return `${PROVIDER_LABEL[p]}: ${formatSyncSummary(r)}`
    })
    .join(" · ")
}

export type SyncResult = { ok: true; summary: string } | { ok: false; error: string }

export async function runKeySync(providers?: KeySyncProvider[]): Promise<SyncResult> {
  try {
    const res = await fetch(SYNC_KEYS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(providers ? { providers } : {}),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: body?.error || `Sync failed (HTTP ${res.status})` }
    return { ok: true, summary: formatKeySyncResponse(body?.providers ?? {}) }
  } catch (e) {
    return { ok: false, error: (e instanceof Error && e.message) || "Sync request failed" }
  }
}

export function KeySyncButton({
  onSynced,
  size = "sm",
  providers,
  label = "Sync keys now",
}: {
  onSynced?: () => void | Promise<void>
  size?: "sm" | "default"
  /** Providers to sync; both when omitted. */
  providers?: KeySyncProvider[]
  label?: string
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SyncResult | null>(null)

  async function sync() {
    setBusy(true)
    setResult(null)
    const r = await runKeySync(providers)
    setResult(r)
    setBusy(false)
    if (r.ok) await onSynced?.()
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size={size} className="gap-2" disabled={busy} onClick={sync}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
        {label}
      </Button>
      {result && (
        <p role="status" className={`flex items-center gap-1 text-xs ${result.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {result.ok ? <CheckCircle2 className="h-3 w-3 text-primary" /> : <AlertCircle className="h-3 w-3" />}
          {result.ok ? `Synced ${result.summary}` : result.error}
        </p>
      )}
    </div>
  )
}
