"use client"

/**
 * /admin/org "API keys & projects": every key grouped by provider, then
 * project or workspace (issue #28, lib/org/key-groups). OpenAI keys sit under
 * projects, Anthropic keys under workspaces, AI Gateway keys under their
 * Vercel project or "No project". Registered keys with no spend yet (e.g.
 * from Sync keys now) are listed too.
 *
 * Owner, team and project are assigned inline through POST
 * /api/admin/org/keys, which marks the assignment manual (the gateway key
 * sync never overwrites it).
 */

import { useMemo } from "react"
import { Loader2, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { KeyRow, ProjectRow } from "@/lib/org/admin/observed"
import { groupKeys } from "@/lib/org/key-groups"
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
  const groups = useMemo(() => {
    if (!keys) return null
    const observedNames = new Map((projects ?? []).map((p) => [`${p.provider_id}:${p.external_project_id}`, p.name]))
    return groupKeys(keys, { providers: org.providers, projects: org.projects, observedNames })
  }, [keys, projects, org.providers, org.projects])

  const personLabel = (id: string | null) => {
    const p = id ? org.people.find((x) => x.id === id) : undefined
    return p ? p.display_name || p.email : null
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys by project</CardTitle>
        <CardDescription>
          Every key seen in collected data plus registered keys, under its project (OpenAI), workspace (Anthropic) or Vercel project (AI Gateway).
          Keys with no spend yet are listed too. A key&apos;s team wins over its owner&apos;s team, which wins over its project&apos;s team. Assigning
          here marks the key <em>manual</em>. Key ids only; secrets are never stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!groups && <Loader2 className="h-4 w-4 animate-spin" />}
        {groups?.length === 0 && <p className="text-sm text-muted-foreground">No keys observed or registered yet.</p>}
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
                      <KeyLine key={`${k.provider_id}:${k.external_key_id}`} k={k} org={org} mutate={mutate} owner={personLabel(k.owner_person_id)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </CardContent>
    </Card>
  )
}

function KeyLine({ k, org, mutate, owner }: { k: KeyRow; org: Org; mutate: Mutate; owner: string | null }) {
  const save = (patch: Record<string, unknown>) =>
    mutate("/keys", "POST", { provider_id: k.provider_id, external_key_id: k.external_key_id, name: k.name, ...patch }, "Key updated")
  const keyProjects = org.projects.filter((p) => p.provider_id === k.provider_id)
  const team = k.team_id ? org.teams.find((t) => t.id === k.team_id)?.name : null
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="admin-key-row">
      <div className="min-w-0">
        <span className="font-medium">{k.name || k.external_key_id}</span>
        {!k.id && (
          <Badge variant="outline" className="ml-2">
            unregistered
          </Badge>
        )}
        <SourceBadge source={k.assignment_source} />
        <p className="text-xs text-muted-foreground">
          <code>{k.external_key_id}</code> · owner {owner ?? "none"} · team {team ?? "none"}
          {k.external_created_by_email && ` · created by ${k.external_created_by_email}`} · last seen {day(k.last_seen)} · {usd(k.total_cost_usd)}
        </p>
      </div>
      <div className="flex items-center gap-1">
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
