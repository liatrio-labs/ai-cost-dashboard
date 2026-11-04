"use client"

/**
 * People -> Possible duplicates (issue #51): likely duplicate person records
 * (same name or same email local-part), pick the record to keep, preview what
 * a merge moves, then merge. Merging needs migration 021; without it the card
 * still lists duplicates and previews, and says merging is disabled.
 */

import { useCallback, useEffect, useState } from "react"
import { AlertCircle, GitMerge, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { DuplicateGroup, DuplicateMember, MergePreview, MergeResult } from "@/lib/org/person-merge"
import type { Org } from "./shared"

const API = "/api/admin/org/people"

interface DuplicatesResponse {
  migration021: boolean
  message: string | null
  groups: DuplicateGroup[]
}

/** Never throws: a network failure comes back as { ok: false, data: { error } } so the buttons re-enable. */
async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; data: T & { error?: string } }> {
  try {
    const res = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, data }
  } catch (e) {
    return { ok: false, data: { error: `Request failed: ${e instanceof Error ? e.message : "network error"}` } as T & { error?: string } }
  }
}

const label = (m: Pick<DuplicateMember, "display_name" | "email">) => m.display_name || m.email
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "2 identities, 1 API key, 2 seat rows, 3 email aliases; adopts team Field". */
export function describeMerge(p: Pick<MergePreview, "identities_moved" | "keys_moved" | "seat_rows_moved" | "aliases_added" | "team_adopted" | "display_name_adopted">, teamName?: string | null) {
  const parts = [
    plural(p.identities_moved, "identity", "identities"),
    plural(p.keys_moved, "API key"),
    plural(p.seat_rows_moved, "seat row"),
    plural(p.aliases_added, "email alias", "email aliases"),
  ]
  const adopt = [p.team_adopted ? `team ${teamName ?? ""}`.trim() : null, p.display_name_adopted ? "name" : null].filter(Boolean)
  return `Moves ${parts.join(", ")}${adopt.length ? `; adopts ${adopt.join(" and ")}` : ""}`
}

function Reasons({ group }: { group: DuplicateGroup }) {
  return (
    <span className="flex flex-wrap gap-1">
      {group.reasons.map((r) => (
        <Badge key={`${r.kind}:${r.value}`} variant="outline">
          {r.kind === "name" ? `same name “${r.value}”` : `same email “${r.value}@”`}
        </Badge>
      ))}
    </span>
  )
}

function GroupRow({
  group,
  org,
  migration021,
  onMerged,
}: {
  group: DuplicateGroup
  org: Org
  migration021: boolean
  onMerged: (text: string) => Promise<void>
}) {
  const [primaryId, setPrimaryId] = useState(group.suggestedPrimaryId)
  const [previews, setPreviews] = useState<Record<string, MergePreview>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const primary = group.members.find((m) => m.id === primaryId) ?? group.members[0]
  const teamName = (id: string | null) => (id ? (org.teams.find((t) => t.id === id)?.name ?? "team") : null)

  const preview = async (secondary: DuplicateMember) => {
    setBusy(`preview:${secondary.id}`)
    setError(null)
    try {
      const res = await post<{ preview?: MergePreview; result?: MergeResult }>("/merge", { primary_id: primary.id, secondary_id: secondary.id, preview: true })
      if (!res.ok || !res.data.preview) return setError(res.data.error || (res.data.result?.already_merged ? "Already merged" : "Preview failed"))
      setPreviews((p) => ({ ...p, [`${primary.id}:${secondary.id}`]: res.data.preview! }))
    } catch (e) {
      setError(`Preview failed: ${e instanceof Error ? e.message : "unknown error"}`)
    } finally {
      setBusy(null)
    }
  }

  const merge = async (secondary: DuplicateMember) => {
    if (!window.confirm(`Merge ${secondary.email} into ${primary.email}? ${secondary.email} is removed; its identities, keys and seat assignments move to ${primary.email}.`)) return
    setBusy(`merge:${secondary.id}`)
    setError(null)
    try {
      const res = await post<{ result?: MergeResult }>("/merge", { primary_id: primary.id, secondary_id: secondary.id })
      if (!res.ok || !res.data.result) return setError(res.data.error || "Merge failed")
      const r = res.data.result
      await onMerged(r.already_merged ? `${secondary.email} was already merged into ${primary.email}` : `Merged ${secondary.email} into ${primary.email}. ${describeMerge(r, teamName(secondary.team_id))}.`)
    } catch (e) {
      setError(`Merge failed: ${e instanceof Error ? e.message : "unknown error"}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-2 py-3" data-testid={`duplicate-group-${group.key}`}>
      <Reasons group={group} />
      <ul className="space-y-2">
        {group.members.map((m) => {
          const isPrimary = m.id === primary.id
          const p = previews[`${primary.id}:${m.id}`]
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex min-w-72 items-center gap-2">
                <input type="radio" name={`primary-${group.key}`} aria-label={`Keep ${m.email}`} checked={isPrimary} onChange={() => setPrimaryId(m.id)} />
                <span className="font-medium">{label(m)}</span>
                <span className="text-muted-foreground">{m.email}</span>
                {!m.active && <Badge variant="secondary">inactive</Badge>}
                {isPrimary && <Badge>keep</Badge>}
              </label>
              <span className="text-xs text-muted-foreground">
                {teamName(m.team_id) ?? "no team"} · {plural(m.identities, "identity", "identities")} · {plural(m.keys, "key")}
              </span>
              {!isPrimary && (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={!!busy} onClick={() => preview(m)}>
                    {busy === `preview:${m.id}` && <Loader2 className="h-3 w-3 animate-spin" />}
                    Preview merge
                  </Button>
                  <Button
                    size="sm"
                    className="gap-1"
                    disabled={!migration021 || !p || !!busy}
                    title={!migration021 ? "Needs migration 021" : !p ? "Preview first" : undefined}
                    onClick={() => merge(m)}
                  >
                    <GitMerge className="h-3 w-3" /> Merge into {label(primary)}
                  </Button>
                </span>
              )}
              {!isPrimary && p && (
                <p className="w-full pl-6 text-xs text-muted-foreground" data-testid={`merge-preview-${m.id}`}>
                  {describeMerge(p, teamName(m.team_id))}. Afterwards: {label(p.result)} · {p.result.email} · {teamName(p.result.team_id) ?? "no team"}
                  {p.result.active ? "" : " · inactive"}.
                </p>
              )}
            </li>
          )
        })}
      </ul>
      {error && (
        <p className="flex items-center gap-1 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </p>
      )}
    </div>
  )
}

export function DuplicatesCard({ org, onMerged }: { org: Org; onMerged: (text: string) => Promise<void> }) {
  const [data, setData] = useState<DuplicatesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`${API}/duplicates`).catch(() => null)
    if (!res) {
      setError("Failed to load duplicates (network error)")
      return
    }
    const body = (await res.json().catch(() => ({}))) as DuplicatesResponse & { error?: string }
    if (!res.ok) {
      setError(body.error || `Failed to load duplicates (${res.status})`)
      return
    }
    setError(null)
    setData(body)
  }, [])

  useEffect(() => {
    // Reload when the org changes (after a merge or any other edit).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load, org])

  if (error) {
    return (
      <p className="flex items-center gap-1 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {error}
      </p>
    )
  }
  if (!data || data.groups.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Possible duplicates ({data.groups.length})</CardTitle>
        <CardDescription>
          People with the same name or the same email before the @. Pick the record to keep, preview, then merge: the other
          record&apos;s identities, owned API keys and seat assignments move to it, and its email becomes an alias so its spend
          follows. Totals don&apos;t change.
        </CardDescription>
        {!data.migration021 && (
          <p role="status" className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <AlertCircle className="h-4 w-4" />
            {data.message || "Migration 021 not applied: merging is disabled."}
          </p>
        )}
      </CardHeader>
      <CardContent className="divide-y divide-border/50">
        {data.groups.map((g) => (
          <GroupRow key={g.key} group={g} org={org} migration021={data.migration021} onMerged={onMerged} />
        ))}
      </CardContent>
    </Card>
  )
}
