"use client"

/**
 * Org spend views (issue #8): breadcrumbs, the department -> team -> person ->
 * (provider x model) drill-down, the People table, the API keys table and
 * the Projects table (issue #24).
 * Presentational: state lives in the URL, so every interaction is a call to
 * onFiltersChange with the next filter set.
 */

import { useMemo, useState } from "react"
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCurrency } from "@/lib/dashboard-types"
import {
  drillInto,
  FILTER_KEYS,
  UNASSIGNED_FILTER,
  type DashboardFilters,
  type DrillLevel,
} from "@/lib/dashboard-filters"
import type {
  BreakdownApiKey,
  BreakdownData,
  BreakdownEntity,
  BreakdownProject,
  BreakdownProvider,
  CoverageNote,
} from "@/lib/org/breakdown"

type OnFilters = (f: DashboardFilters) => void

const LEVEL_TITLE: Record<DrillLevel, string> = {
  department: "Departments",
  team: "Teams",
  person: "People",
  detail: "Provider and model detail",
}

const visible = (e: Pick<BreakdownEntity, "unassigned" | "cost" | "prevCost">) => e.unassigned || e.cost !== 0 || e.prevCost !== 0

function Change({ value, cost }: { value: number | null; cost: number }) {
  if (value === null) return <span className="text-muted-foreground">{cost === 0 ? "–" : "new"}</span>
  if (value === 0) return <span className="text-muted-foreground">0%</span>
  const up = value > 0
  return (
    <span className={up ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
      {up ? "+" : ""}
      {value}%
    </span>
  )
}

export function coverageText(notes: CoverageNote[]): string {
  return notes.map((n) => `${n.providerName}: ${n.note}`).join("; ")
}

function Coverage({ notes, unassigned }: { notes: CoverageNote[]; unassigned: boolean }) {
  if (notes.length === 0) return null
  return (
    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground" data-testid="coverage">
      {unassigned ? "Includes " : "Not included: "}
      {coverageText(notes)}
    </p>
  )
}

export function OrgBreadcrumbs({ data, onFiltersChange }: { data: BreakdownData; onFiltersChange: OnFilters }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => onFiltersChange({})}
      >
        All spend
      </button>
      {data.breadcrumbs.map((c, i) => {
        const last = i === data.breadcrumbs.length - 1
        return (
          <span key={c.key} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            {last ? (
              <span aria-current="page" className="font-medium text-foreground">
                {c.label}
              </span>
            ) : (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  const keep: DashboardFilters = {}
                  for (const k of data.breadcrumbs.slice(0, i + 1)) keep[k.key] = k.value
                  onFiltersChange(keep)
                }}
              >
                {c.label}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}

export function DrilldownTable({ data, onFiltersChange }: { data: BreakdownData; onFiltersChange: OnFilters }) {
  const level = data.level
  if (level === "detail") return <DetailTable data={data} />
  const rows = data[level].filter(visible)
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">{LEVEL_TITLE[level]}</CardTitle>
        <CardDescription>
          Spend for the period vs {data.comparePeriod.start} to {data.comparePeriod.end}. Select a row to drill in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label={LEVEL_TITLE[level]}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Previous</TableHead>
              <TableHead className="text-right">Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.key}>
                <TableCell>
                  <button
                    type="button"
                    className="text-left font-medium hover:underline"
                    onClick={() => onFiltersChange(drillInto(data.filters, level, e.key))}
                  >
                    {e.label}
                  </button>
                  <Coverage notes={e.coverage} unassigned={e.unassigned} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(e.cost)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatCurrency(e.prevCost)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <Change value={e.changePercent} cost={e.cost} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function DetailTable({ data }: { data: BreakdownData }) {
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">{LEVEL_TITLE.detail}</CardTitle>
        <CardDescription>Spend by provider and model for the current selection</CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label={LEVEL_TITLE.detail}>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Spend</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.detail.map((d) => (
              <TableRow key={`${d.provider}:${d.model}`}>
                <TableCell>{d.providerName}</TableCell>
                <TableCell className="font-mono text-xs">{d.model}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(d.cost)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

type PeopleSort = { by: "spend" | "name" | string; dir: "asc" | "desc" }

function personCell(p: BreakdownProvider, e: BreakdownEntity) {
  if (p.person === "no") {
    return (
      <span className="text-muted-foreground" title={`${p.name}: ${p.note}`}>
        n/a
      </span>
    )
  }
  const v = e.byProvider[p.slug] ?? 0
  return v ? formatCurrency(v) : <span className="text-muted-foreground">–</span>
}

export function PeopleTable({ data, onFiltersChange }: { data: BreakdownData; onFiltersChange: OnFilters }) {
  const [sort, setSort] = useState<PeopleSort>({ by: "spend", dir: "desc" })
  const rows = useMemo(() => {
    const people = data.person.filter(visible)
    const value = (e: BreakdownEntity) =>
      sort.by === "spend" ? e.cost : sort.by === "name" ? 0 : (e.byProvider[sort.by] ?? 0)
    const sorted = [...people.filter((e) => !e.unassigned)].sort((a, b) => {
      const d = sort.by === "name" ? a.label.localeCompare(b.label) : value(a) - value(b)
      return sort.dir === "asc" ? d : -d
    })
    // Unassigned stays last whatever the sort.
    return [...sorted, ...people.filter((e) => e.unassigned)]
  }, [data.person, sort])

  const header = (by: string, label: string, title?: string) => {
    const active = sort.by === by
    return (
      <button
        type="button"
        title={title}
        className="inline-flex items-center gap-1 hover:text-foreground"
        aria-label={`Sort by ${label}`}
        onClick={() => setSort({ by, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
      >
        {label}
        {active && (sort.dir === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    )
  }

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">People</CardTitle>
        <CardDescription>
          Per-provider spend. &quot;n/a&quot; means the provider can&apos;t attribute spend to people, not $0.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label="People">
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={sort.by === "name" ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                {header("name", "Name")}
              </TableHead>
              <TableHead
                className="text-right"
                aria-sort={sort.by === "spend" ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
              >
                {header("spend", "Spend")}
              </TableHead>
              <TableHead className="text-right">Change</TableHead>
              {data.providers.map((p) => (
                <TableHead key={p.slug} className="text-right">
                  {header(p.slug, p.name, `${p.name}: ${p.note}`)}
                  {p.person === "via_key_owner" && <span title="Attributed via API key owner">*</span>}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.key} data-testid="person-row">
                <TableCell>
                  <button
                    type="button"
                    className="text-left font-medium hover:underline"
                    onClick={() => onFiltersChange({ ...data.filters, person: e.key })}
                  >
                    {e.label}
                  </button>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(e.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <Change value={e.changePercent} cost={e.cost} />
                </TableCell>
                {data.providers.map((p) => (
                  <TableCell key={p.slug} className="text-right tabular-nums">
                    {personCell(p, e)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/**
 * Registered keys grouped by provider, then project / workspace (issue #28):
 * OpenAI keys under projects, Anthropic keys under workspaces, AI Gateway
 * keys under Vercel projects or "No project". With no org filter every key is
 * listed; a person / team / department filter lists the keys it owns (even at
 * $0) plus keys with spend in the selection (issue #35). A group heading
 * filters by that project; a key filters by key.
 * Spend on unregistered keys stays in the last "Unassigned" row.
 */
export function ApiKeysTable({ data, onFiltersChange }: { data: BreakdownData; onFiltersChange: OnFilters }) {
  const unassigned = data.api_key.filter((k) => k.unassigned && visible(k)) as BreakdownApiKey[]
  const groups = data.key_groups ?? []
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">API keys</CardTitle>
        <CardDescription>
          Registered provider API keys under their project (OpenAI), workspace (Anthropic) or Vercel project (AI Gateway), including keys with no
          spend yet. A person, team or department filter shows the keys they own plus any key with spend from them. Select a project to filter
          by it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label="API keys">
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Team</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.flatMap((pg) =>
              pg.projects.flatMap((g) => [
                <TableRow key={`group:${g.key}`} data-testid="key-group-row" className="bg-muted/30 hover:bg-muted/30">
                  <TableCell colSpan={4} className="py-1.5 text-xs">
                    <span className="text-muted-foreground">
                      {pg.label} · {pg.noun}:{" "}
                    </span>
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      aria-label={`Filter by ${pg.noun.toLowerCase()} ${g.label}`}
                      onClick={() => onFiltersChange({ ...data.filters, project: g.external_id ?? UNASSIGNED_FILTER })}
                    >
                      {g.label}
                    </button>
                    <span className="ml-2 text-muted-foreground">
                      {g.keys.length} key{g.keys.length === 1 ? "" : "s"}
                    </span>
                  </TableCell>
                  <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">{formatCurrency(g.total_cost_usd)}</TableCell>
                  <TableCell />
                </TableRow>,
                ...g.keys.map((k) => (
                  <TableRow key={k.key} data-testid="key-row">
                    <TableCell>{k.providerName ?? "—"}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left font-medium hover:underline"
                        onClick={() => onFiltersChange({ ...data.filters, key: k.key })}
                      >
                        {k.label}
                      </button>
                      <Coverage notes={k.coverage} unassigned={false} />
                    </TableCell>
                    <TableCell>{k.owner ?? "—"}</TableCell>
                    <TableCell>{k.team ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(k.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <Change value={k.changePercent} cost={k.cost} />
                    </TableCell>
                  </TableRow>
                )),
              ])
            )}
            {unassigned.map((k) => (
              <TableRow key={k.key} data-testid="key-row">
                <TableCell>—</TableCell>
                <TableCell>
                  <button
                    type="button"
                    className="text-left font-medium hover:underline"
                    onClick={() => onFiltersChange({ ...data.filters, key: k.key })}
                  >
                    Unassigned (no registered key)
                  </button>
                  <Coverage notes={k.coverage} unassigned />
                </TableCell>
                <TableCell>—</TableCell>
                <TableCell>—</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(k.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <Change value={k.changePercent} cost={k.cost} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function ProjectsTable({ data, onFiltersChange }: { data: BreakdownData; onFiltersChange: OnFilters }) {
  const projects = (data.project ?? []).filter(visible) as BreakdownProject[]
  // Shown whenever any provider reports a project or workspace (issue #28),
  // even if this period's filters leave only the Unassigned row.
  const any = data.hasProjects ?? projects.some((p) => !p.unassigned)
  if (!any) return null
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">Projects</CardTitle>
        <CardDescription>
          Spend by provider project (OpenAI projects, Anthropic workspaces, Vercel projects via project-scoped AI Gateway keys). Select one to
          filter the keys and the rest of the page. Gateway spend from OIDC, PATs or app tokens has no project and stays Unassigned.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label="Projects">
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Team</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((p) => (
              <TableRow key={p.key} data-testid="project-row">
                <TableCell>{p.providerName ?? "—"}</TableCell>
                <TableCell>
                  <button
                    type="button"
                    className="text-left font-medium hover:underline"
                    onClick={() => onFiltersChange({ ...data.filters, project: p.key })}
                  >
                    {p.unassigned ? "Unassigned (no project)" : p.label}
                  </button>
                  {p.kind === "workspace" && <span className="ml-2 text-xs text-muted-foreground">workspace</span>}
                </TableCell>
                <TableCell>{p.team ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(p.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <Change value={p.changePercent} cost={p.cost} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"

/** Combinable filters. Native selects keep this simple and accessible. */
export function OrgFilterBar({
  data,
  filters,
  onFiltersChange,
}: {
  data: BreakdownData | null
  filters: DashboardFilters
  onFiltersChange: OnFilters
}) {
  const o = data?.options
  // Does a filter value accept an entity id? "unassigned" accepts null.
  const accepts = (want: string | undefined, have: string | null) =>
    !want || (want === UNASSIGNED_FILTER ? have === null : have === want)
  const deptOfTeam = (teamId: string | null) =>
    teamId ? (o?.teams.find((t) => t.id === teamId)?.departmentId ?? null) : null
  const teamFits = (teamId: string, f: DashboardFilters) =>
    accepts(f.department, teamId === UNASSIGNED_FILTER ? null : deptOfTeam(teamId))
  // Can this person's spend appear under the team / department filters?
  // Uses where their spend lands (API key teams included), not just home team.
  const inScope = (want: string | undefined, ids: string[]) => !want || ids.includes(want)
  const personFits = (p: { teamIds: string[]; departmentIds: string[] }, f: DashboardFilters) =>
    inScope(f.team, p.teamIds) && inScope(f.department, p.departmentIds)

  const teams = o?.teams.filter((t) => accepts(filters.department, t.departmentId)) ?? []
  const people = o?.people.filter((p) => personFits(p, filters) || p.id === filters.person) ?? []
  // A team-less row has no department, so "Unassigned" team only makes sense
  // without a specific department.
  const teamUnassignedOk = !filters.department || filters.department === UNASSIGNED_FILTER
  const set = (k: keyof DashboardFilters, v: string) => {
    const next = { ...filters }
    if (v) next[k] = v
    else delete next[k]
    // Filters AND together, so drop child filters the new parent excludes
    // instead of leaving a combination that matches nothing.
    if (k === "department" || k === "team") {
      if (next.team && !teamFits(next.team, next)) delete next.team
      const person = next.person && next.person !== UNASSIGNED_FILTER ? o?.people.find((p) => p.id === next.person) : undefined
      if (person && !personFits(person, next)) delete next.person
    }
    onFiltersChange(next)
  }
  const field = (k: keyof DashboardFilters, label: string, opts: { value: string; label: string }[], unassigned = true) => (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <select aria-label={label} className={selectClass} value={filters[k] ?? ""} onChange={(e) => set(k, e.target.value)}>
        <option value="">All</option>
        {opts.map((x) => (
          <option key={x.value} value={x.value}>
            {x.label}
          </option>
        ))}
        {unassigned && <option value="unassigned">Unassigned</option>}
      </select>
    </label>
  )
  const active = FILTER_KEYS.some((k) => filters[k])
  return (
    <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Filters">
      {field("department", "Department", o?.departments.map((d) => ({ value: d.id, label: d.label })) ?? [])}
      {field("team", "Team", teams.map((t) => ({ value: t.id, label: t.label })), teamUnassignedOk)}
      {field("person", "Person", people.map((p) => ({ value: p.id, label: p.label })))}
      {field("key", "API key", o?.apiKeys.map((k) => ({ value: k.id, label: k.label })) ?? [])}
      {field("project", "Project", o?.projects?.map((p) => ({ value: p.id, label: p.label })) ?? [])}
      {field("provider", "Provider", o?.providers.map((p) => ({ value: p.slug, label: p.label })) ?? [], false)}
      {active && (
        <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => onFiltersChange({})}>
          Clear filters
        </button>
      )}
    </div>
  )
}

/** The Org tab: breadcrumbs, the drill-down, People, API keys and projects. */
export function OrgBreakdown({ data, onFiltersChange }: { data: BreakdownData; onFiltersChange: OnFilters }) {
  return (
    <div className="space-y-6">
      <OrgBreadcrumbs data={data} onFiltersChange={onFiltersChange} />
      {/* At team level the People table is the drill-down (it adds per-provider columns). */}
      {data.level !== "person" && <DrilldownTable data={data} onFiltersChange={onFiltersChange} />}
      {data.level !== "detail" && <PeopleTable data={data} onFiltersChange={onFiltersChange} />}
      <ApiKeysTable data={data} onFiltersChange={onFiltersChange} />
      <ProjectsTable data={data} onFiltersChange={onFiltersChange} />
    </div>
  )
}
