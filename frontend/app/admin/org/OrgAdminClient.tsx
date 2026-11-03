"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { AlertCircle, ArrowLeft, Loader2, Plus, RefreshCw, Trash2, UserPlus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LiatrioMark } from "@/components/liatrio-logo"
import { ModeToggle } from "@/components/mode-toggle"
import { unassignedGatewayKeys, type ImportPreview, type KeyRow, type ProjectRow, type UnassignedQueue } from "@/lib/org/admin/observed"
import { KeySyncButton } from "@/components/admin/gateway-key-sync"
import { AssignToCreatorButton, KeysByProjectCard } from "./keys-by-project"
import { canAssignToCreator } from "@/lib/org/key-status"
import { SourceBadge, TeamSelect, selectClass, usd, type Mutate, type Org } from "./shared"

const API = "/api/admin/org"

type ApiResult<T = unknown> = { ok: boolean; status: number; data: T & { error?: string } }

async function api<T = unknown>(path: string, method = "GET", body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

function Message({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null
  return (
    <p className={`flex items-center gap-1 text-sm ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>
      {!msg.ok && <AlertCircle className="h-4 w-4" />}
      {msg.text}
    </p>
  )
}

export function OrgAdminClient() {
  const [org, setOrg] = useState<Org | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(async () => {
    const res = await api<Org>("")
    if (res.ok) {
      setOrg(res.data)
      setLoadError(null)
    } else {
      setLoadError(res.data.error || `Failed to load (${res.status})`)
    }
    setReloadKey((k) => k + 1)
  }, [])

  useEffect(() => {
    // Initial load; reload() only sets state after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload()
  }, [reload])

  /** Run a mutation, report the result, reload. Handles the 409 "confirm to reassign" flow. */
  const mutate = useCallback(
    async (path: string, method: string, body?: unknown, okText?: string) => {
      setMsg(null)
      let res = await api(path, method, body)
      if (res.status === 409 && method === "DELETE") {
        if (!window.confirm(`${res.data.error}\n\nMove them to Unassigned and delete?`)) return false
        res = await api(`${path}${path.includes("?") ? "&" : "?"}confirm=true`, method, body)
      }
      if (!res.ok) {
        setMsg({ ok: false, text: res.data.error || `Request failed (${res.status})` })
        return false
      }
      if (okText) setMsg({ ok: true, text: okText })
      await reload()
      return true
    },
    [reload]
  )

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <LiatrioMark className="h-7" />
            <h1 className="text-lg font-semibold">Admin · Org structure</h1>
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle />
            <Button variant="outline" size="sm" className="gap-2" onClick={reload}>
              <RefreshCw className="h-4 w-4" />
              Reload
            </Button>
            <Link href="/admin">
              <Button variant="ghost" size="sm" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back to admin
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
        {loadError && <Message msg={{ ok: false, text: loadError }} />}
        <Message msg={msg} />
        {!org ? (
          !loadError && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <Tabs defaultValue="unassigned">
            <TabsList>
              <TabsTrigger value="unassigned">Unassigned</TabsTrigger>
              <TabsTrigger value="structure">Departments & teams</TabsTrigger>
              <TabsTrigger value="people">People</TabsTrigger>
              <TabsTrigger value="keys">API keys & projects</TabsTrigger>
              <TabsTrigger value="import">Import</TabsTrigger>
            </TabsList>
            <TabsContent value="unassigned">
              <UnassignedTab org={org} mutate={mutate} reloadKey={reloadKey} />
            </TabsContent>
            <TabsContent value="structure">
              <StructureTab org={org} mutate={mutate} />
            </TabsContent>
            <TabsContent value="people">
              <PeopleTab org={org} mutate={mutate} />
            </TabsContent>
            <TabsContent value="keys">
              <KeysTab org={org} mutate={mutate} reload={reload} reloadKey={reloadKey} />
            </TabsContent>
            <TabsContent value="import">
              <ImportTab org={org} mutate={mutate} />
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Departments & teams
// ---------------------------------------------------------------------------

function StructureTab({ org, mutate }: { org: Org; mutate: Mutate }) {
  const [deptName, setDeptName] = useState("")
  const [teamName, setTeamName] = useState("")
  const [teamDept, setTeamDept] = useState("")

  const counts = (teamId: string) => ({
    people: org.people.filter((p) => p.team_id === teamId).length,
    keys: org.apiKeys.filter((k) => k.team_id === teamId).length,
    projects: org.projects.filter((p) => p.team_id === teamId).length,
  })

  const rename = (kind: "departments" | "teams", id: string, current: string) => {
    const name = window.prompt("New name", current)
    if (name && name.trim() !== current) mutate(`/${kind}/${id}`, "PATCH", { name }, "Renamed")
  }

  const sections = [
    ...org.departments.map((d) => ({ dept: d as Org["departments"][number] | null, teams: org.teams.filter((t) => t.department_id === d.id) })),
    { dept: null, teams: org.teams.filter((t) => !t.department_id) },
  ]

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card className="md:col-span-1">
        <CardHeader>
          <CardTitle>Add</CardTitle>
          <CardDescription>Departments group teams. A team can sit outside any department.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await mutate("/departments", "POST", { name: deptName }, "Department added")) setDeptName("")
            }}
          >
            <Input placeholder="Department name" value={deptName} onChange={(e) => setDeptName(e.target.value)} />
            <Button type="submit" size="sm" disabled={!deptName.trim()}>
              <Plus className="h-4 w-4" />
            </Button>
          </form>
          <form
            className="space-y-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await mutate("/teams", "POST", { name: teamName, department_id: teamDept || null }, "Team added")) setTeamName("")
            }}
          >
            <Input placeholder="Team name" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
            <div className="flex gap-2">
              <select aria-label="Department" className={`${selectClass} flex-1`} value={teamDept} onChange={(e) => setTeamDept(e.target.value)}>
                <option value="">No department</option>
                {org.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm" disabled={!teamName.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-4 md:col-span-2">
        {sections.map(({ dept, teams }) =>
          !dept && !teams.length ? null : (
            <Card key={dept?.id ?? "none"}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">{dept?.name ?? "No department"}</CardTitle>
                {dept && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => rename("departments", dept.id, dept.name)}>
                      Rename
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`Delete ${dept.name}`} onClick={() => mutate(`/departments/${dept.id}`, "DELETE", undefined, "Department deleted")}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="divide-y divide-border/50">
                {!teams.length && <p className="text-sm text-muted-foreground">No teams.</p>}
                {teams.map((t) => {
                  const c = counts(t.id)
                  return (
                    <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div>
                        <span className="font-medium">{t.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {c.people} people · {c.keys} keys · {c.projects} projects
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <select
                          aria-label={`Move ${t.name}`}
                          className={selectClass}
                          value={t.department_id ?? ""}
                          onChange={(e) => mutate(`/teams/${t.id}`, "PATCH", { department_id: e.target.value || null }, "Team moved")}
                        >
                          <option value="">No department</option>
                          {org.departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                        <Button variant="ghost" size="sm" onClick={() => rename("teams", t.id, t.name)}>
                          Rename
                        </Button>
                        <Button variant="ghost" size="sm" aria-label={`Delete ${t.name}`} onClick={() => mutate(`/teams/${t.id}`, "DELETE", undefined, "Team deleted")}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          )
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// People and identities
// ---------------------------------------------------------------------------

function PeopleTab({ org, mutate }: { org: Org; mutate: Mutate }) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [team, setTeam] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [showInactive, setShowInactive] = useState(false)
  const [identityFor, setIdentityFor] = useState<string | null>(null)
  const [idProvider, setIdProvider] = useState("")
  const [idValue, setIdValue] = useState("")

  const providerName = (id: string) => {
    const p = org.providers.find((x) => x.id === id)
    return p?.display_name || p?.name || id
  }
  const q = filter.trim().toLowerCase()
  const people = org.people.filter(
    (p) =>
      (showInactive || p.active !== false) &&
      (!q || p.email.includes(q) || (p.display_name ?? "").toLowerCase().includes(q))
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Add person</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await mutate("/people", "POST", { email, display_name: name || null, team_id: team }, "Person added")) {
                setEmail("")
                setName("")
              }
            }}
          >
            <Input className="w-64" type="email" placeholder="email@liatrio.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input className="w-48" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <TeamSelect org={org} value={team} onChange={setTeam} />
            <Button type="submit" size="sm" className="gap-1" disabled={!email.trim()}>
              <UserPlus className="h-4 w-4" /> Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>People ({people.length})</CardTitle>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1 text-sm text-muted-foreground">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show inactive
            </label>
            <Input className="w-56" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        </CardHeader>
        <CardContent className="divide-y divide-border/50">
          {people.map((p) => {
            const ids = org.identities.filter((i) => i.person_id === p.id)
            return (
              <div key={p.id} className="space-y-2 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">{p.display_name || p.email}</span>
                    {p.display_name && <span className="ml-2 text-sm text-muted-foreground">{p.email}</span>}
                    {p.active === false && (
                      <Badge variant="secondary" className="ml-2">
                        inactive
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <TeamSelect
                      org={org}
                      value={p.team_id}
                      ariaLabel={`Team for ${p.email}`}
                      onChange={(teamId) => mutate(`/people/${p.id}`, "PATCH", { team_id: teamId }, "Team updated")}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const n = window.prompt("Name", p.display_name ?? "")
                        if (n !== null) mutate(`/people/${p.id}`, "PATCH", { display_name: n || null }, "Saved")
                      }}
                    >
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setIdentityFor(identityFor === p.id ? null : p.id)}>
                      Identities ({ids.length})
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => mutate(`/people/${p.id}`, "PATCH", { active: p.active === false }, p.active === false ? "Reactivated" : "Deactivated")}
                    >
                      {p.active === false ? "Reactivate" : "Deactivate"}
                    </Button>
                  </div>
                </div>
                {identityFor === p.id && (
                  <div className="ml-4 space-y-2 rounded-md border border-border/50 p-3">
                    {ids.map((i) => (
                      <div key={i.id} className="flex items-center justify-between text-sm">
                        <span>
                          {providerName(i.provider_id)}: <code>{i.external_id}</code>
                        </span>
                        <Button variant="ghost" size="sm" aria-label="Remove identity" onClick={() => mutate(`/identities/${i.id}`, "DELETE", undefined, "Identity removed")}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <form
                      className="flex flex-wrap gap-2"
                      onSubmit={async (e) => {
                        e.preventDefault()
                        if (await mutate("/identities", "POST", { person_id: p.id, provider_id: idProvider, external_id: idValue }, "Identity added")) setIdValue("")
                      }}
                    >
                      <select aria-label="Provider" className={selectClass} value={idProvider} onChange={(e) => setIdProvider(e.target.value)}>
                        <option value="">Provider…</option>
                        {org.providers.map((pr) => (
                          <option key={pr.id} value={pr.id}>
                            {pr.display_name || pr.name}
                          </option>
                        ))}
                      </select>
                      <Input className="w-64" placeholder="Provider user id or alias email" value={idValue} onChange={(e) => setIdValue(e.target.value)} />
                      <Button type="submit" size="sm" disabled={!idProvider || !idValue.trim()}>
                        Add identity
                      </Button>
                    </form>
                  </div>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// API keys and projects
// ---------------------------------------------------------------------------

function KeysTab({ org, mutate, reload, reloadKey }: { org: Org; mutate: Mutate; reload: () => Promise<void>; reloadKey: number }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null)
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([api<KeyRow[]>("/keys"), api<ProjectRow[]>("/projects")]).then(([k, p]) => {
      if (!live) return
      setKeys(k.ok ? k.data : [])
      setProjects(p.ok ? p.data : [])
    })
    return () => {
      live = false
    }
  }, [reloadKey])

  const providerName = (id: string) => {
    const p = org.providers.find((x) => x.id === id)
    return p?.display_name || p?.name || id
  }
  const gatewayId = org.providers.find((p) => p.name === "vercel-ai-gateway")?.id ?? null

  return (
    <div className="space-y-4">
      <GatewayKeysCard org={org} mutate={mutate} reload={reload} keys={keys} gatewayId={gatewayId} />

      <KeysByProjectCard org={org} mutate={mutate} keys={keys} projects={projects} />

      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>
            OpenAI and Vercel projects, and Anthropic workspaces. A project&apos;s team applies only when neither the key nor the person has one. Workspace
            teams don&apos;t feed the rollup yet, so only their names can be set here.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border/50">
          {!projects && <Loader2 className="h-4 w-4 animate-spin" />}
          {projects?.length === 0 && <p className="text-sm text-muted-foreground">No projects observed yet.</p>}
          {projects?.map((p) => (
            <div key={`${p.provider_id}:${p.external_project_id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <span className="font-medium">{p.name || p.external_project_id}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {providerName(p.provider_id)} · {p.kind === "workspace" ? "workspace" : "project"} · <code>{p.external_project_id}</code> · {usd(p.total_cost_usd)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Input
                  key={`${p.external_project_id}:${p.name ?? ""}`}
                  aria-label={`Name for ${p.external_project_id}`}
                  className="h-9 w-40"
                  placeholder="Name"
                  defaultValue={p.name ?? ""}
                  onBlur={(e) => {
                    const name = e.target.value.trim()
                    if (name && name !== (p.name ?? ""))
                      mutate("/projects", "POST", { provider_id: p.provider_id, external_project_id: p.external_project_id, name }, "Project renamed")
                  }}
                />
                {p.kind !== "workspace" && (
                  <TeamSelect
                    org={org}
                    value={p.team_id}
                    noneLabel="No team"
                    ariaLabel={`Team for ${p.external_project_id}`}
                    onChange={(teamId) =>
                      mutate("/projects", "POST", { provider_id: p.provider_id, external_project_id: p.external_project_id, name: p.name, team_id: teamId }, "Project updated")
                    }
                  />
                )}
                {p.id && (
                  <Button variant="ghost" size="sm" aria-label="Unregister project" onClick={() => mutate(`/projects/${p.id}`, "DELETE", undefined, "Project unregistered")}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * AI Gateway keys with no owner, team or project: their spend is Unassigned
 * until assigned here (or until the key sync maps them). Assigning marks the
 * key "manual".
 */
function GatewayKeysCard({
  org,
  mutate,
  reload,
  keys,
  gatewayId,
}: {
  org: Org
  mutate: Mutate
  reload: () => Promise<void>
  keys: KeyRow[] | null
  gatewayId: string | null
}) {
  if (!gatewayId) return null
  const pending = keys ? unassignedGatewayKeys(keys, gatewayId) : null
  const projects = org.projects.filter((p) => p.provider_id === gatewayId)
  const projectLabel = (k: KeyRow) => {
    const id = k.org_project_id ?? null
    const pr = id ? org.projects.find((p) => p.id === id) : org.projects.find((p) => p.provider_id === k.provider_id && p.external_project_id === k.observed_project_id)
    return pr?.name || pr?.external_project_id || k.observed_project_id || "No project"
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Unassigned gateway keys</CardTitle>
            <CardDescription>
              Vercel AI Gateway keys with no owner, project or team. Keys set to &quot;user&quot; spend attribution map to their creator and project-scoped keys to their
              project automatically on every collection. Assigning here marks the key <em>manual</em>, and the sync never overwrites it.
            </CardDescription>
          </div>
          <KeySyncButton onSynced={reload} />
        </div>
      </CardHeader>
      <CardContent className="divide-y divide-border/50">
        {!pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {pending?.length === 0 && <p className="text-sm text-muted-foreground">Every gateway key is assigned to a person, project or team.</p>}
        {pending?.map((k) => {
          const save = (patch: Record<string, unknown>, text: string) =>
            mutate("/keys", "POST", { provider_id: k.provider_id, external_key_id: k.external_key_id, name: k.name, ...patch }, text)
          return (
            <div key={k.external_key_id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="gateway-key-row">
              <div>
                <span className="font-medium">{k.name || k.external_key_id}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {k.external_created_by_email ?? "creator unknown"} · {projectLabel(k)} · spend {k.spend_attribution ?? "unset (team)"} · {usd(k.total_cost_usd)}
                </span>
                <SourceBadge source={k.assignment_source} />
              </div>
              <div className="flex items-center gap-1">
                {canAssignToCreator(k, "vercel-ai-gateway") && <AssignToCreatorButton k={k} mutate={mutate} />}
                <select
                  aria-label={`Assign ${k.external_key_id} to a person`}
                  className={selectClass}
                  value=""
                  onChange={(e) => e.target.value && save({ owner_person_id: e.target.value }, `Assigned ${k.name || k.external_key_id}`)}
                >
                  <option value="">Person…</option>
                  {org.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name || p.email}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Assign ${k.external_key_id} to a project`}
                  className={selectClass}
                  value=""
                  disabled={!projects.length}
                  onChange={(e) => e.target.value && save({ org_project_id: e.target.value }, `Assigned ${k.name || k.external_key_id}`)}
                >
                  <option value="">Project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.external_project_id}
                    </option>
                  ))}
                </select>
                <TeamSelect
                  org={org}
                  value={null}
                  noneLabel="Team…"
                  ariaLabel={`Assign ${k.external_key_id} to a team`}
                  onChange={(teamId) => teamId && save({ team_id: teamId }, `Assigned ${k.name || k.external_key_id}`)}
                />
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Import from observed data
// ---------------------------------------------------------------------------

function ImportTab({ org, mutate }: { org: Org; mutate: Mutate }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [team, setTeam] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runPreview() {
    setLoading(true)
    setError(null)
    const res = await api<ImportPreview>("/people/import", "POST", {})
    setLoading(false)
    if (!res.ok) return setError(res.data.error || "Preview failed")
    setPreview(res.data)
    setSelected(new Set(res.data.candidates.map((c) => c.email)))
  }

  async function confirm() {
    if (await mutate("/people/import", "POST", { confirm: true, emails: [...selected], team_id: team }, `Imported ${selected.size} people`)) {
      setPreview(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import people from observed data</CardTitle>
        <CardDescription>
          Finds every person email in collected cost records that doesn&apos;t match a person or identity yet. Preview first; nothing is created until you confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={runPreview} disabled={loading} className="gap-2">
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Preview (dry run)
        </Button>
        {error && <Message msg={{ ok: false, text: error }} />}
        {preview && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {preview.candidates.length} new email(s); {preview.already_known.length} already known.
            </p>
            {preview.conflicts.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Not importable ({preview.conflicts.length}): {preview.conflicts.map((c) => c.email).join(", ")}. These already belong to someone through an identity on another
                provider; add an identity for the unmatched provider to that person instead.
              </p>
            )}
            <div className="max-h-96 divide-y divide-border/50 overflow-auto rounded-md border border-border/50">
              {preview.candidates.map((c) => (
                <label key={c.email} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(c.email)}
                      onChange={(e) => {
                        const next = new Set(selected)
                        if (e.target.checked) next.add(c.email)
                        else next.delete(c.email)
                        setSelected(next)
                      }}
                    />
                    {c.email}
                    {c.display_name && <span className="text-muted-foreground">({c.display_name})</span>}
                  </span>
                  <span className="text-muted-foreground">{usd(c.total_cost_usd)}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm">Team for imported people:</span>
              <TeamSelect org={org} value={team} onChange={setTeam} />
              <Button onClick={confirm} disabled={!selected.size}>
                Import {selected.size}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Unassigned queue
// ---------------------------------------------------------------------------

const KIND_LABEL = { person: "Person", api_key: "API key", project: "Project", other: "Other" } as const

function UnassignedTab({ org, mutate, reloadKey }: { org: Org; mutate: Mutate; reloadKey: number }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [queue, setQueue] = useState<UnassignedQueue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<Record<string, string | null>>({})

  useEffect(() => {
    let live = true
    api<UnassignedQueue>(`/unassigned?month=${month}`).then((res) => {
      if (!live) return
      if (res.ok) {
        setQueue(res.data)
        setError(null)
      } else {
        setError(res.data.error || "Failed to load")
      }
    })
    return () => {
      live = false
    }
  }, [month, reloadKey])

  const providerName = (id: string | null) => {
    const p = org.providers.find((x) => x.id === id)
    return p?.display_name || p?.name || id || ""
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Unassigned spend</CardTitle>
          <CardDescription>
            Spend with no team, grouped by person email, then API key, then project. Assigning a group moves its spend (including history) on the next rollup refresh.
          </CardDescription>
        </div>
        <Input type="month" aria-label="Month" className="w-40" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <Message msg={{ ok: false, text: error }} />}
        {!queue && !error && <Loader2 className="h-4 w-4 animate-spin" />}
        {queue && (
          <>
            <p className="text-sm text-muted-foreground">
              {usd(queue.unassigned_total_usd)} of {usd(queue.org_total_usd)} unassigned · person {usd(queue.subtotals.person)} · API key {usd(queue.subtotals.api_key)} · project{" "}
              {usd(queue.subtotals.project)} · other {usd(queue.subtotals.other)}
            </p>
            {!queue.groups.length && <p className="text-sm">Nothing unassigned this month.</p>}
            <div className="divide-y divide-border/50">
              {queue.groups.map((g) => {
                const id = `${g.kind}|${g.key}`
                const teamId = choice[id] ?? null
                const assign = () => {
                  if (!teamId) return
                  const body =
                    g.kind === "person"
                      ? { kind: "person", email: g.email, display_name: g.person_id ? undefined : g.label !== g.email ? g.label : undefined, team_id: teamId }
                      : g.kind === "api_key"
                        ? { kind: "api_key", provider_id: g.provider_id, external_key_id: g.external_id, name: g.label !== g.external_id ? g.label : undefined, team_id: teamId }
                        : { kind: "project", provider_id: g.provider_id, external_project_id: g.external_id, name: g.label !== g.external_id ? g.label : undefined, team_id: teamId }
                  mutate("/unassigned/assign", "POST", body, `Assigned ${g.label}`)
                }
                return (
                  <div key={id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <Badge variant="outline" className="mr-2">
                        {KIND_LABEL[g.kind]}
                      </Badge>
                      <span className="font-medium">{g.label}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {g.provider_ids.map(providerName).join(", ")} · {g.record_count} records
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-24 text-right font-mono text-sm">{usd(g.total_cost_usd)}</span>
                      {g.kind !== "other" ? (
                        <>
                          <TeamSelect org={org} value={teamId} noneLabel="Choose team…" ariaLabel={`Team for ${g.label}`} onChange={(t) => setChoice({ ...choice, [id]: t })} />
                          <Button size="sm" disabled={!teamId} onClick={assign}>
                            Assign
                          </Button>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">No person, key or project to assign</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
