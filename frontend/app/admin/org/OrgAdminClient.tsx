"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { AlertCircle, ArrowLeft, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LiatrioMark } from "@/components/liatrio-logo"
import { ModeToggle } from "@/components/mode-toggle"
import type { ObservedPerson, ApiKeyListing, UnassignedQueue } from "@/lib/org/observed"
import type { OrgData } from "@/lib/org/types"

interface Provider {
  id: string
  name: string
  display_name: string | null
}

type OrgResponse = OrgData & { providers: Provider[] }

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })

/** fetch + JSON with the API's { error } surfaced as an Error. */
async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`) as Error & { status?: number; data?: unknown }
    err.status = res.status
    err.data = data
    throw err
  }
  return data as T
}

function TeamSelect({
  org,
  value,
  onChange,
  placeholder = "No team",
}: {
  org: OrgData
  value: string | null
  onChange: (id: string | null) => void
  placeholder?: string
}) {
  const deptName = (id: string | null) => org.departments.find((d) => d.id === id)?.name ?? "No department"
  return (
    <select className={selectClass} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{placeholder}</option>
      {org.teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name} ({deptName(t.department_id)})
        </option>
      ))}
    </select>
  )
}

export function OrgAdminClient() {
  const [org, setOrg] = useState<OrgResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setOrg(await api<OrgResponse>("/api/admin/org"))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load")
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** Run a mutation, surface its error, then reload the org. */
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await fn()
        await load()
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed")
        return false
      } finally {
        setBusy(false)
      }
    },
    [load]
  )

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <LiatrioMark className="h-7" />
            <h1 className="text-lg font-semibold">Admin · Org structure</h1>
          </div>
          <div className="flex items-center gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <ModeToggle />
            <Link href="/admin">
              <Button variant="ghost" size="sm" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Admin
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {!org ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Tabs defaultValue="unassigned">
            <TabsList>
              <TabsTrigger value="unassigned">Unassigned</TabsTrigger>
              <TabsTrigger value="structure">Departments &amp; teams</TabsTrigger>
              <TabsTrigger value="people">People</TabsTrigger>
              <TabsTrigger value="keys">API keys</TabsTrigger>
            </TabsList>
            <TabsContent value="unassigned">
              <UnassignedTab org={org} run={run} />
            </TabsContent>
            <TabsContent value="structure">
              <StructureTab org={org} run={run} />
            </TabsContent>
            <TabsContent value="people">
              <PeopleTab org={org} run={run} />
            </TabsContent>
            <TabsContent value="keys">
              <KeysTab org={org} run={run} />
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  )
}

type Run = (fn: () => Promise<unknown>) => Promise<boolean>

// ---------------------------------------------------------------------------
// Departments & teams
// ---------------------------------------------------------------------------

function StructureTab({ org, run }: { org: OrgResponse; run: Run }) {
  const [deptName, setDeptName] = useState("")
  const [teamName, setTeamName] = useState("")
  const [teamDept, setTeamDept] = useState<string>("")

  /** Delete; on a 409 "still has members" ask, then retry with confirm=true. */
  const remove = (path: string, label: string) =>
    run(async () => {
      try {
        await api(path, "DELETE")
      } catch (e) {
        const err = e as Error & { status?: number }
        if (err.status !== 409) throw e
        if (!window.confirm(`${err.message}\n\nMove them to Unassigned and delete ${label}?`)) return
        await api(`${path}?confirm=true`, "DELETE")
      }
    })

  const rename = (path: string, current: string) => {
    const name = window.prompt("New name", current)
    if (name && name.trim() && name !== current) run(() => api(path, "PATCH", { name }))
  }

  const groups = [
    ...org.departments.map((d) => ({ id: d.id as string | null, name: d.name })),
    { id: null, name: "No department" },
  ]

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Add</CardTitle>
          <CardDescription>Teams roll up into departments. Team names are unique within a department.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await run(() => api("/api/admin/org/departments", "POST", { name: deptName }))) setDeptName("")
            }}
          >
            <Input className="max-w-xs" placeholder="Department name" value={deptName} onChange={(e) => setDeptName(e.target.value)} />
            <Button type="submit" size="sm" className="gap-2" disabled={!deptName.trim()}>
              <Plus className="h-4 w-4" /> Department
            </Button>
          </form>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              const ok = await run(() =>
                api("/api/admin/org/teams", "POST", { name: teamName, department_id: teamDept || null })
              )
              if (ok) setTeamName("")
            }}
          >
            <Input className="max-w-xs" placeholder="Team name" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
            <select className={selectClass} value={teamDept} onChange={(e) => setTeamDept(e.target.value)}>
              <option value="">No department</option>
              {org.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" className="gap-2" disabled={!teamName.trim()}>
              <Plus className="h-4 w-4" /> Team
            </Button>
          </form>
        </CardContent>
      </Card>

      {groups.map((g) => {
        const teams = org.teams.filter((t) => (t.department_id ?? null) === g.id)
        if (g.id === null && !teams.length) return null
        return (
          <Card key={g.id ?? "none"}>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">{g.name}</CardTitle>
              {g.id && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => rename(`/api/admin/org/departments/${g.id}`, g.name)}>
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => remove(`/api/admin/org/departments/${g.id}`, g.name)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {!teams.length ? (
                <p className="text-sm text-muted-foreground">No teams.</p>
              ) : (
                <ul className="divide-y divide-border/50">
                  {teams.map((t) => {
                    const people = org.people.filter((p) => p.team_id === t.id).length
                    const keys = org.apiKeys.filter((k) => k.team_id === t.id).length
                    return (
                      <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div>
                          <p className="text-sm font-medium">{t.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {people} people · {keys} API keys
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <select
                            className={selectClass}
                            value={t.department_id ?? ""}
                            aria-label={`Department for ${t.name}`}
                            onChange={(e) =>
                              run(() => api(`/api/admin/org/teams/${t.id}`, "PATCH", { department_id: e.target.value || null }))
                            }
                          >
                            <option value="">No department</option>
                            {org.departments.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name}
                              </option>
                            ))}
                          </select>
                          <Button size="sm" variant="ghost" onClick={() => rename(`/api/admin/org/teams/${t.id}`, t.name)}>
                            Rename
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => remove(`/api/admin/org/teams/${t.id}`, t.name)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// People (+ identities, + import from observed data)
// ---------------------------------------------------------------------------

function PeopleTab({ org, run }: { org: OrgResponse; run: Run }) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [team, setTeam] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [preview, setPreview] = useState<ObservedPerson[] | null>(null)
  const [importTeam, setImportTeam] = useState<string | null>(null)
  const [identityFor, setIdentityFor] = useState<string | null>(null)
  const [identity, setIdentity] = useState({ provider_id: "", external_id: "" })

  const providerName = (id: string) => {
    const p = org.providers.find((x) => x.id === id)
    return p?.display_name || p?.name || id
  }
  const people = org.people.filter((p) => showInactive || p.active !== false)
  const newPeople = preview?.filter((p) => !p.existing_person_id) ?? []

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Import from observed data</CardTitle>
          <CardDescription>
            Finds distinct person emails in collected cost records (last 365 days). Preview first; nothing is created
            until you confirm.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                run(async () => {
                  const res = await api<{ candidates: ObservedPerson[] }>("/api/admin/org/people/import")
                  setPreview(res.candidates)
                })
              }
            >
              Preview import
            </Button>
            {preview && newPeople.length > 0 && (
              <>
                <TeamSelect org={org} value={importTeam} onChange={setImportTeam} placeholder="Import with no team" />
                <Button
                  size="sm"
                  onClick={async () => {
                    const ok = await run(() =>
                      api("/api/admin/org/people/import", "POST", { confirm: true, team_id: importTeam })
                    )
                    if (ok) setPreview(null)
                  }}
                >
                  Create {newPeople.length} people
                </Button>
              </>
            )}
          </div>
          {preview && (
            <p className="text-sm text-muted-foreground">
              {preview.length} observed emails, {newPeople.length} new.
            </p>
          )}
          {preview && newPeople.length > 0 && (
            <ul className="max-h-64 divide-y divide-border/50 overflow-auto text-sm">
              {newPeople.map((p) => (
                <li key={p.email} className="flex justify-between gap-2 py-1.5">
                  <span>
                    {p.email}
                    {p.name ? <span className="text-muted-foreground"> · {p.name}</span> : null}
                  </span>
                  <span className="text-muted-foreground">
                    {p.provider_ids.map(providerName).join(", ")} · {usd(p.total_cost_usd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add person</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              const ok = await run(() =>
                api("/api/admin/org/people", "POST", { email, display_name: name || null, team_id: team })
              )
              if (ok) {
                setEmail("")
                setName("")
              }
            }}
          >
            <Input className="max-w-xs" type="email" placeholder="email@liatrio.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input className="max-w-xs" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <TeamSelect org={org} value={team} onChange={setTeam} />
            <Button type="submit" size="sm" className="gap-2" disabled={!email.trim()}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>People ({people.length})</CardTitle>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border/50">
            {people.map((p) => {
              const ids = org.identities.filter((i) => i.person_id === p.id)
              return (
                <li key={p.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">
                        {p.display_name || p.email}{" "}
                        {p.active === false && <Badge variant="secondary">inactive</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">{p.email}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <TeamSelect
                        org={org}
                        value={p.team_id}
                        onChange={(id) => run(() => api(`/api/admin/org/people/${p.id}`, "PATCH", { team_id: id }))}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const n = window.prompt("Name", p.display_name ?? "")
                          if (n !== null) run(() => api(`/api/admin/org/people/${p.id}`, "PATCH", { display_name: n || null }))
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setIdentityFor(identityFor === p.id ? null : p.id)}>
                        Identities ({ids.length})
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => run(() => api(`/api/admin/org/people/${p.id}`, "PATCH", { active: p.active === false }))}
                      >
                        {p.active === false ? "Reactivate" : "Deactivate"}
                      </Button>
                    </div>
                  </div>
                  {identityFor === p.id && (
                    <div className="space-y-2 rounded-md border border-border/50 p-3">
                      {ids.map((i) => (
                        <div key={i.id} className="flex items-center justify-between text-sm">
                          <span>
                            {providerName(i.provider_id)}: <code>{i.external_id}</code>
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => run(() => api(`/api/admin/org/identities/${i.id}`, "DELETE"))}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      <form
                        className="flex flex-wrap gap-2"
                        onSubmit={async (e) => {
                          e.preventDefault()
                          const ok = await run(() => api("/api/admin/org/identities", "POST", { person_id: p.id, ...identity }))
                          if (ok) setIdentity({ provider_id: "", external_id: "" })
                        }}
                      >
                        <select
                          className={selectClass}
                          value={identity.provider_id}
                          onChange={(e) => setIdentity((s) => ({ ...s, provider_id: e.target.value }))}
                        >
                          <option value="">Provider…</option>
                          {org.providers.map((pr) => (
                            <option key={pr.id} value={pr.id}>
                              {pr.display_name || pr.name}
                            </option>
                          ))}
                        </select>
                        <Input
                          className="max-w-xs"
                          placeholder="Provider user id or email"
                          value={identity.external_id}
                          onChange={(e) => setIdentity((s) => ({ ...s, external_id: e.target.value }))}
                        />
                        <Button type="submit" size="sm" disabled={!identity.provider_id || !identity.external_id.trim()}>
                          Map identity
                        </Button>
                      </form>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function KeysTab({ org, run }: { org: OrgResponse; run: Run }) {
  const [keys, setKeys] = useState<ApiKeyListing[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api<{ keys: ApiKeyListing[] }>("/api/admin/org/api-keys")
      .then((res) => !cancelled && setKeys(res.keys))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load keys"))
    return () => {
      cancelled = true
    }
  }, [org])

  const providerName = (id: string) => {
    const p = org.providers.find((x) => x.id === id)
    return p?.display_name || p?.name || id
  }

  const assign = (k: ApiKeyListing, fields: { owner_person_id?: string | null; team_id?: string | null }) =>
    run(() =>
      api("/api/admin/org/api-keys", "POST", {
        provider_id: k.provider_id,
        external_key_id: k.external_key_id,
        ...(k.registered ? {} : { name: k.name }),
        ...fields,
      })
    )

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          Keys seen in collected data (last 90 days) plus registered keys. A key&apos;s team takes precedence over its
          owner&apos;s team. Key ids only; secrets are never stored.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!keys ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !keys.length ? (
          <p className="text-sm text-muted-foreground">No API keys observed or registered yet.</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {keys.map((k) => (
              <li key={`${k.provider_id}:${k.external_key_id}`} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {k.name || k.external_key_id}{" "}
                    {!k.registered && <Badge variant="outline">unregistered</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {providerName(k.provider_id)} · <code>{k.external_key_id}</code> · {usd(k.total_cost_usd)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <select
                    className={selectClass}
                    aria-label="Owner"
                    value={k.owner_person_id ?? ""}
                    onChange={(e) => assign(k, { owner_person_id: e.target.value || null })}
                  >
                    <option value="">No owner</option>
                    {org.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.display_name || p.email}
                      </option>
                    ))}
                  </select>
                  <TeamSelect org={org} value={k.team_id} onChange={(id) => assign(k, { team_id: id })} />
                  {k.id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      title="Unregister"
                      onClick={() => run(() => api(`/api/admin/org/api-keys/${k.id}`, "DELETE"))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Unassigned queue
// ---------------------------------------------------------------------------

function UnassignedTab({ org, run }: { org: OrgResponse; run: Run }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [queue, setQueue] = useState<UnassignedQueue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picks, setPicks] = useState<Record<string, string | null>>({})

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api<UnassignedQueue>(`/api/admin/org/unassigned?month=${month}`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load")
    }
  }, [month])

  useEffect(() => {
    let cancelled = false
    api<UnassignedQueue>(`/api/admin/org/unassigned?month=${month}`)
      .then((res) => {
        if (cancelled) return
        setQueue(res)
        setError(null)
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load"))
    return () => {
      cancelled = true
    }
  }, [month, org])

  const providerNames = useMemo(
    () => new Map(org.providers.map((p) => [p.id, p.display_name || p.name])),
    [org.providers]
  )

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1.5">
          <CardTitle>Unassigned spend</CardTitle>
          <CardDescription>
            Spend this month that resolves to no team, grouped by person, API key or project. Pick a team to assign.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Input type="month" className="w-40" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          <Button size="sm" variant="ghost" onClick={loadQueue} title="Reload">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!queue ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <p className="text-sm">
              <span className="font-medium">{usd(queue.unassigned_cost_usd)}</span> unassigned of{" "}
              {usd(queue.total_cost_usd)} total ({usd(queue.assigned_cost_usd)} assigned to a team).
            </p>
            {!queue.groups.length ? (
              <p className="text-sm text-muted-foreground">Nothing unassigned.</p>
            ) : (
              <ul className="divide-y divide-border/50">
                {queue.groups.map((g) => (
                  <li key={g.key} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        <Badge variant="outline" className="mr-2">
                          {g.kind === "api_key" ? "API key" : g.kind}
                        </Badge>
                        {g.label}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {usd(g.total_cost_usd)} · {g.record_count} records ·{" "}
                        {g.provider_ids.map((id) => providerNames.get(id) ?? id).join(", ")}
                        {g.email && g.email !== g.label ? ` · ${g.email}` : ""}
                        {g.external_key_id && g.external_key_id !== g.label ? ` · ${g.external_key_id}` : ""}
                      </p>
                    </div>
                    {g.assignable ? (
                      <div className="flex items-center gap-1">
                        <TeamSelect
                          org={org}
                          value={picks[g.key] ?? null}
                          onChange={(id) => setPicks((p) => ({ ...p, [g.key]: id }))}
                          placeholder="Choose team…"
                        />
                        <Button
                          size="sm"
                          disabled={!picks[g.key]}
                          onClick={() =>
                            run(() =>
                              api(
                                "/api/admin/org/unassigned/assign",
                                "POST",
                                g.kind === "person"
                                  ? { kind: "person", email: g.email, display_name: !g.person_id && g.label !== g.email ? g.label : undefined, team_id: picks[g.key] }
                                  : {
                                      kind: "api_key",
                                      provider_id: g.provider_id,
                                      external_key_id: g.external_key_id,
                                      name: g.label !== g.external_key_id ? g.label : null,
                                      team_id: picks[g.key],
                                    }
                              )
                            )
                          }
                        >
                          Assign
                        </Button>
                      </div>
                    ) : (
                      <p className="max-w-xs text-xs text-muted-foreground">{g.reason}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
