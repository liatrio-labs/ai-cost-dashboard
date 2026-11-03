"use client"

/**
 * "Sync keys now" for Vercel AI Gateway keys (issue #28). Used on /admin (in
 * the pull card) and /admin/org ("API keys & projects"). Calls
 * POST /api/admin/org/keys/sync-gateway, which registers every gateway key in
 * org_api_keys (keys with no spend included) and never overwrites manual
 * assignments. Shows the counts, or the error, inline.
 */

import { useState } from "react"
import { AlertCircle, CheckCircle2, KeyRound, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

export const SYNC_GATEWAY_URL = "/api/admin/org/keys/sync-gateway"

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
  if (n(s.unresolved_creators)) parts.push(`${s.unresolved_creators} creators not matched to an email`)
  return parts.join("; ")
}

export type SyncResult = { ok: true; summary: GatewaySyncCounts } | { ok: false; error: string }

export async function runGatewayKeySync(): Promise<SyncResult> {
  try {
    const res = await fetch(SYNC_GATEWAY_URL, { method: "POST" })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: body?.error || `Sync failed (HTTP ${res.status})` }
    return { ok: true, summary: body as GatewaySyncCounts }
  } catch (e) {
    return { ok: false, error: (e instanceof Error && e.message) || "Sync request failed" }
  }
}

export function GatewayKeySyncButton({ onSynced, size = "sm" }: { onSynced?: () => void | Promise<void>; size?: "sm" | "default" }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SyncResult | null>(null)

  async function sync() {
    setBusy(true)
    setResult(null)
    const r = await runGatewayKeySync()
    setResult(r)
    setBusy(false)
    if (r.ok) await onSynced?.()
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size={size} className="gap-2" disabled={busy} onClick={sync}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
        Sync keys now
      </Button>
      {result && (
        <p role="status" className={`flex items-center gap-1 text-xs ${result.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {result.ok ? <CheckCircle2 className="h-3 w-3 text-primary" /> : <AlertCircle className="h-3 w-3" />}
          {result.ok ? `Synced ${formatSyncSummary(result.summary)}` : result.error}
        </p>
      )}
    </div>
  )
}
