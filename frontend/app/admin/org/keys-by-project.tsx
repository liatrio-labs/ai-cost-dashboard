"use client"

/**
 * /admin/org "API keys & projects": every key grouped by provider, then
 * project or workspace (issue #28, lib/org/key-groups). OpenAI keys sit under
 * projects, Anthropic keys under workspaces, AI Gateway keys under their
 * Vercel project or "No project". Registered keys with no spend yet (e.g.
 * from Sync keys now) are listed too.
 *
 * Owner, team and project are assigned inline through POST
 * /api/admin/org/keys, which marks the assignment manual (the key syncs
 * never overwrite it).
 *
 * Issue #32: Anthropic keys show their status and creator; keys the sync
 * couldn't give an owner (service account, deleted or unmatched creator, no
 * creator) are listed under "Unassigned keys" with the reason. Issue #34: the
 * gateway sync makes the creator every gateway key's default owner, and
 * gateway keys with no owner (no creator, unmatched creator) are listed there
 * too. "Assign to creator" (POST /api/admin/org/keys/assign-creator, manual)
 * is an override on any gateway key with a creator email whose owner isn't
 * that creator.
 *
 * Issue #45: keys with $0 spend are hidden by default (this page has no
 * period, so spend is all collected data), with search, status chips and a
 * read-only "Consider revoking" list (active keys with $0 in 90 days). The
 * provider's creation date shows when migration 018 is applied.
 */

import { useMemo, useState } from "react"
import { Loader2, Trash2, UserCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { KeyRow, ProjectRow } from "@/lib/org/admin/observed"
import { groupKeys } from "@/lib/org/key-groups"
import { considerRevoking, DEFAULT_KEY_FILTER, filterGroups, filterKeys, type KeyFilter } from "@/lib/org/key-filter"
import { canAssignToCreator, unresolvedReasonText } from "@/lib/org/key-status"
import { ConsiderRevoking, isoDay, KeyFilterBar } from "@/components/org/key-filter-bar"
import { SourceBadge, TeamSelect, selectClass, usd, type Mutate, type Org } from "./shared"

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "never")

export function KeysByProjectCard({
  org,
  mutate,
  keys,
  projects,
}: {
  org: Org
  mutate: Mutate
  keys: KeyRow[] | null
  projects: ProjectRow[] | null
}) {
  const allGroups = useMemo(() => {
    if (!keys) return null
    const observedNames = new Map((projects ?? []).map((p) => [`${p.provider_id}:${p.external_project_id}`, p.name]))
    return groupKeys(keys, { providers: org.providers, projects: org.projects, observedNames })
  }, [keys, projects, org.providers, org.projects])
  const [keyFilter, setKeyFilter] = useState<KeyFilter>(DEFAULT_KEY_FILTER)

  const personLabel = (id: string | null) => {
    const p = id ? org.people.find((x) => x.id === id) : undefined
    return p ? p.display_name || p.email : null
  }
  const personEmail = (id: string | null) => (id ? (org.people.find((x) => x.id === id)?.email ?? null) : null)

  // Group order (spend) is kept; filters only drop keys (lib/org/key-filter).
  const ordered = allGroups?.flatMap((pg) => pg.projects.flatMap((g) => g.keys)) ?? []
  const result = filterKeys(ordered, keyFilter, (k) => ({
    spend: k.total_cost_usd,
    status: k.external_status,
    text: [k.name, k.external_key_id, personLabel(k.owner_person_id), personEmail(k.owner_person_id), k.external_created_by_email],
  }))
  const groups = allGroups ? filterGroups(allGroups, new Set(result.keys)) : null
  const providerLabel = new Map((allGroups ?? []).map((pg) => [pg.provider_id, pg.label]))
  const revoke = considerRevoking(ordered, (k) => ({
    status: k.external_status,
    spend90d: k.spend_90d,
    lastSpend: k.last_spend,
    label: k.name || k.external_key_id,
  }))

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys by project</CardTitle>
        <CardDescription>
          Every key seen in collected data plus registered keys, under its project (OpenAI), workspace (Anthropic) or Vercel project (AI Gateway).
          Keys with $0 spend (all collected data) are hidden unless you show them. A key&apos;s team wins over its owner&apos;s team, which wins over its project&apos;s team. Assigning
          here marks the key <em>manual</em>. Key ids only; secrets are never stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!groups && <Loader2 className="h-4 w-4 animate-spin" />}
        {allGroups && allGroups.length > 0 && <KeyFilterBar filter={keyFilter} onChange={setKeyFilter} result={result} label="Admin API keys" />}
        {allGroups?.length === 0 && <p className="text-sm text-muted-foreground">No keys observed or registered yet.</p>}
        {allGroups && allGroups.length > 0 && groups?.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="admin-keys-empty">
            No keys match these filters.
            {!keyFilter.showAll && (
              <button type="button" className="ml-2 underline hover:text-foreground" onClick={() => setKeyFilter({ ...keyFilter, showAll: true })}>
                Show $0 keys
              </button>
            )}
          </p>
        )}
        {groups?.map((pg) => (
          <section key={pg.provider_id} aria-label={pg.label} data-testid="key-provider-group">
            <h3 className="flex items-baseline justify-between text-sm font-semibold">
              <span>{pg.label}</span>
              <span className="text-xs font-normal text-muted-foreground">{usd(pg.total_cost_usd)}</span>
            </h3>
            <div className="mt-2 space-y-3">
              {pg.projects.map((g) => (
                <div key={g.key} className="rounded-md border border-border/50" role="group" aria-label={`${pg.noun}: ${g.label}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/50 bg-muted/30 px-3 py-1.5 text-xs">
                    <span>
                      <span className="text-muted-foreground">{pg.noun}: </span>
                      <span className="font-medium">{g.label}</span>
                      {g.external_id && g.label !== g.external_id && (
                        <code className="ml-2 text-muted-foreground">{g.external_id}</code>
                      )}
                      {g.team_id && (
                        <span className="ml-2 text-muted-foreground">team {org.teams.find((t) => t.id === g.team_id)?.name ?? g.team_id}</span>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      {g.keys.length} key{g.keys.length === 1 ? "" : "s"} · {usd(g.total_cost_usd)}
                    </span>
                  </div>
                  <div className="divide-y divide-border/50 px-3">
                    {g.keys.map((k) => (
                      <KeyLine
                        key={`${k.provider_id}:${k.external_key_id}`}
                        k={k}
                        org={org}
                        mutate={mutate}
                        owner={personLabel(k.owner_person_id)}
                        ownerEmail={personEmail(k.owner_person_id)}
                        providerSlug={pg.provider_slug}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <UnassignedKeys keys={pg.projects.flatMap((g) => g.keys)} />
            </div>
          </section>
        ))}
        <ConsiderRevoking
          items={revoke.map((k) => ({
            key: `${k.provider_id}:${k.external_key_id}`,
            label: k.name || k.external_key_id,
            provider: providerLabel.get(k.provider_id) ?? null,
            owner: personLabel(k.owner_person_id),
            lastSpend: k.last_spend,
            createdAt: k.provider_created_at,
          }))}
        />
      </CardContent>
    </Card>
  )
}

/** Keys the sync left without an owner, with the reason (issues #32, #34; Anthropic and AI Gateway alike). */
function UnassignedKeys({ keys }: { keys: KeyRow[] }) {
  const pending = keys.filter((k) => !k.owner_person_id && k.unresolved_reason)
  if (!pending.length) return null
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs" role="group" aria-label="Unassigned keys">
      <p className="font-medium">Unassigned keys</p>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        {pending.map((k) => (
          <li key={`${k.provider_id}:${k.external_key_id}`} data-testid="unassigned-key">
            <span className="text-foreground">{k.name || k.external_key_id}</span>: {unresolvedReasonText(k.unresolved_reason)} · {usd(k.total_cost_usd)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Vercel "Assign to creator" (issue #32): owner = the creator's person, marked manual. */
export function AssignToCreatorButton({ k, mutate }: { k: KeyRow; mutate: Mutate }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1"
      title={`Make ${k.external_created_by_email} the owner (manual; the sync won't change it)`}
      aria-label={`Assign ${k.external_key_id} to creator`}
      onClick={() =>
        mutate("/keys/assign-creator", "POST", { provider_id: k.provider_id, external_key_id: k.external_key_id }, `Assigned to ${k.external_created_by_email}`)
      }
    >
      <UserCheck className="h-4 w-4" />
      Assign to creator
    </Button>
  )
}

function KeyLine({
  k,
  org,
  mutate,
  owner,
  ownerEmail,
  providerSlug,
}: {
  k: KeyRow
  org: Org
  mutate: Mutate
  owner: string | null
  ownerEmail?: string | null
  providerSlug: string | null
}) {
  const save = (patch: Record<string, unknown>) =>
    mutate("/keys", "POST", { provider_id: k.provider_id, external_key_id: k.external_key_id, name: k.name, ...patch }, "Key updated")
  const keyProjects = org.projects.filter((p) => p.provider_id === k.provider_id)
  const team = k.team_id ? org.teams.find((t) => t.id === k.team_id)?.name : null
  const creator = k.external_created_by_email ?? (k.external_created_by?.includes(":") ? k.external_created_by : null)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="admin-key-row">
      <div className="min-w-0">
        <span className="font-medium">{k.name || k.external_key_id}</span>
        {!k.id && (
          <Badge variant="outline" className="ml-2">
            unregistered
          </Badge>
        )}
        {k.external_status && (
          <Badge variant={k.external_status === "active" ? "outline" : "secondary"} className="ml-2">
            {k.external_status}
          </Badge>
        )}
        <SourceBadge source={k.assignment_source} />
        <p className="text-xs text-muted-foreground">
          <code>{k.external_key_id}</code> · owner {owner ?? "none"}
          {!owner && k.unresolved_reason && ` (${unresolvedReasonText(k.unresolved_reason)})`} · team {team ?? "none"}
          {creator && ` · created by ${creator}`}
          {k.provider_created_at && ` · created ${isoDay(k.provider_created_at)}`} · last seen {day(k.last_seen)} · {usd(k.total_cost_usd)}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {canAssignToCreator(k, providerSlug, ownerEmail) && <AssignToCreatorButton k={k} mutate={mutate} />}
        <select
          aria-label={`Owner of ${k.external_key_id}`}
          className={selectClass}
          value={k.owner_person_id ?? ""}
          onChange={(e) => save({ owner_person_id: e.target.value || null })}
        >
          <option value="">No owner</option>
          {org.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name || p.email}
            </option>
          ))}
        </select>
        {keyProjects.length > 0 && (
          <select
            aria-label={`Project for ${k.external_key_id}`}
            className={selectClass}
            value={k.org_project_id ?? ""}
            onChange={(e) => save({ org_project_id: e.target.value || null })}
          >
            <option value="">No project</option>
            {keyProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.external_project_id}
              </option>
            ))}
          </select>
        )}
        <TeamSelect org={org} value={k.team_id} noneLabel="No team" ariaLabel={`Team for ${k.external_key_id}`} onChange={(teamId) => save({ team_id: teamId })} />
        {k.id && (
          <Button variant="ghost" size="sm" aria-label={`Unregister ${k.external_key_id}`} onClick={() => mutate(`/keys/${k.id}`, "DELETE", undefined, "Key unregistered")}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
