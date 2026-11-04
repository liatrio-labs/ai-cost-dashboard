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
import { formatCurrency, projectionTooltip } from "@/lib/dashboard-types"
import { splitHeaderLabel } from "@/lib/header-label"
import { cn } from "@/lib/utils"
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
  BreakdownKeyItem,
  BreakdownProject,
  BreakdownProvider,
  CoverageNote,
} from "@/lib/org/breakdown"
import { considerRevoking, DEFAULT_KEY_FILTER, filterGroups, filterKeys, hasSpend, matchesQuery, type KeyFilter } from "@/lib/org/key-filter"
import { ConsiderRevoking, isoDay, KeyFilterBar } from "./key-filter-bar"

type OnFilters = (f: DashboardFilters) => void

const LEVEL_TITLE: Record<DrillLevel, string> = {
  department: "Departments",
  team: "Teams",
  person: "People",
  detail: "Provider and model detail",
}

const visible = (e: Pick<BreakdownEntity, "unassigned" | "cost" | "prevCost">) => e.unassigned || e.cost !== 0 || e.prevCost !== 0

type Changeable = Pick<BreakdownEntity, "cost" | "changePercent" | "projectedCost" | "projectedChangePercent">

/**
 * The Change cell. A period containing today shows the projected change vs
 * the previous full period, labelled "proj." with a tooltip (issue #39); a
 * future period shows none; a past one compares actuals.
 */
export function changeCell(e: Changeable, projection: BreakdownData["projection"] | undefined) {
  if (projection?.status === "future") return { value: null, text: "–", title: "No change for a future period", projected: false }
  if (projection?.status === "current" && e.projectedCost !== null && e.projectedCost !== undefined) {
    const title = `${projectionTooltip(
      { completeDays: projection.completeDays ?? 0, completeThrough: projection.completeThrough },
      e.cost
    )}; projected ${formatCurrency(e.projectedCost)}`
    const v = e.projectedChangePercent
    if (v === null) return { value: null, text: e.projectedCost === 0 && e.cost === 0 ? "–" : "new", title, projected: true }
    return { value: v, text: `${v > 0 ? "+" : ""}${v}% proj.`, title, projected: true }
  }
  const v = e.changePercent
  if (v === null) return { value: null, text: e.cost === 0 ? "–" : "new", title: undefined, projected: false }
  return { value: v, text: `${v > 0 ? "+" : ""}${v}%`, title: undefined, projected: false }
}

function Change({ e, projection }: { e: Changeable; projection: BreakdownData["projection"] | undefined }) {
  const c = changeCell(e, projection)
  const cls =
    c.value === null || c.value === 0
      ? "text-muted-foreground"
      : c.value > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400"
  return (
    <span className={cls} title={c.title} data-projected={c.projected || undefined}>
      {c.text}
    </span>
  )
}

export function coverageText(notes: CoverageNote[]): string {
  return notes.map((n) => `${n.providerName}: ${n.note}`).join("; ")
}

/**
 * The coverage text every list shares, or null when any differs or is empty.
 * Lets a table show an identical "Not included" note once (issue #41).
 */
export function sharedCoverageText(lists: CoverageNote[][]): string | null {
  if (lists.length === 0) return null
  const first = coverageText(lists[0])
  return first && lists.every((l) => coverageText(l) === first) ? first : null
}

function Coverage({ notes, unassigned, testId = "coverage" }: { notes: CoverageNote[]; unassigned: boolean; testId?: string }) {
  if (notes.length === 0) return null
  // Wraps inside nowrap table cells so a long note can't set the table width (issue #41).
  return (
    <p className="mt-0.5 text-[11px] leading-snug whitespace-normal break-words text-muted-foreground" data-testid={testId}>
      {unassigned ? "Includes " : "Not included: "}
      {coverageText(notes)}
    </p>
  )
}

/**
 * A column header whose trailing parenthetical goes on line 2, e.g.
 * "Anthropic" / "(Claude API)" (issue #41). Each line stays nowrap; headers
 * without a parenthetical render unchanged on one line.
 */
export function HeaderLabel({ label, align = "left" }: { label: string; align?: "left" | "right" }) {
  const { primary, secondary } = splitHeaderLabel(label)
  if (!secondary) return <>{label}</>
  return (
    <span
      data-testid="header-label"
      className={cn("inline-flex flex-col leading-tight", align === "right" ? "items-end text-right" : "items-start text-left")}
    >
      <span>{primary}</span> <span>{secondary}</span>
    </span>
  )
}

const changeHeader = (data: BreakdownData) => (
  <HeaderLabel label={data.projection?.status === "current" ? "Change (projected)" : "Change"} align="right" />
)

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
              <TableHead className="text-right">{changeHeader(data)}</TableHead>
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
                  <Change e={e} projection={data.projection} />
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

  const ariaSort = (by: string) => (sort.by === by ? (sort.dir === "asc" ? "ascending" : "descending") : undefined)
  const header = (by: string, label: string, title?: string, align: "left" | "right" = "left") => {
    const active = sort.by === by
    return (
      <button
        type="button"
        title={title}
        className="inline-flex items-center gap-1 hover:text-foreground"
        aria-label={`Sort by ${label}`}
        onClick={() => setSort({ by, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
      >
        <HeaderLabel label={label} align={align} />
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
              <TableHead aria-sort={ariaSort("name")}>
                {header("name", "Name")}
              </TableHead>
              <TableHead className="text-right" aria-sort={ariaSort("spend")}>
                {header("spend", "Spend", undefined, "right")}
              </TableHead>
              <TableHead className="text-right">{changeHeader(data)}</TableHead>
              {data.providers.map((p) => (
                <TableHead key={p.slug} className="text-right" aria-sort={ariaSort(p.slug)}>
                  {header(p.slug, p.name, `${p.name}: ${p.note}`, "right")}
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
                  <Change e={e} projection={data.projection} />
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
/** Wrapping, width-capped Name cell so a long key name or note can't widen the table (issue #41). */
const NAME_CELL = "min-w-40 max-w-xs whitespace-normal"

const UNASSIGNED_KEY_LABEL = "Unassigned (no registered key)"
const keyFields = (k: BreakdownKeyItem) => ({ spend: k.cost, status: k.status, text: [k.label, k.owner, k.external_key_id] })

export function ApiKeysTable({ data, onFiltersChange }: { data: BreakdownData; onFiltersChange: OnFilters }) {
  // Issue #45: $0 keys hidden by default; search and status chips combine with
  // it and never reorder (lib/org/key-filter).
  const [keyFilter, setKeyFilter] = useState<KeyFilter>(DEFAULT_KEY_FILTER)
  const allGroups = data.key_groups ?? []
  const allKeys = allGroups.flatMap((pg) => pg.projects.flatMap((g) => g.keys))
  const result = filterKeys(allKeys, keyFilter, keyFields)
  const groups = filterGroups(allGroups, new Set(result.keys))
  // The Unassigned spend row isn't a key: it has no status and shows with spend unless a status chip is on.
  const unassigned = (data.api_key.filter((k) => k.unassigned && visible(k)) as BreakdownApiKey[]).filter(
    (k) =>
      keyFilter.status === "all" &&
      (keyFilter.showAll || hasSpend(k.cost)) &&
      matchesQuery([UNASSIGNED_KEY_LABEL], keyFilter.query)
  )
  const revoke = considerRevoking(allKeys, (k) => ({ status: k.status, spend90d: k.spend_90d, lastSpend: k.last_spend, label: k.label }))
  // An identical "Not included" note shows once (issue #41): in the description
  // when every registered key shares it, else in a group's header row when every
  // key in that group shares it. Any other row keeps its own note. Only the
  // rows the key filters leave count (issue #45).
  const tableNote = result.keys.length > 1 ? sharedCoverageText(result.keys.map((k) => k.coverage)) : null
  const groupNote = (keys: { coverage: CoverageNote[] }[]) =>
    tableNote || keys.length < 2 ? null : sharedCoverageText(keys.map((k) => k.coverage))
  const empty = groups.length === 0 && unassigned.length === 0
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">API keys</CardTitle>
        <CardDescription>
          Registered provider API keys under their project (OpenAI), workspace (Anthropic) or Vercel project (AI Gateway), including keys with no
          spend yet. A person, team or department filter shows the keys they own plus any key with spend from them. Select a project to filter
          by it. Keys with $0 in the period are hidden unless you show them.
          {tableNote && (
            <span className="mt-1 block text-xs" data-testid="coverage-shared">
              Not included for every key: {tableNote}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <KeyFilterBar filter={keyFilter} onChange={setKeyFilter} result={result} />
        <Table aria-label="API keys">
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Team</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">{changeHeader(data)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.flatMap((pg) =>
              pg.projects.flatMap((g) => {
                const shared = groupNote(g.keys)
                return [
                <TableRow key={`group:${g.key}`} data-testid="key-group-row" className="bg-muted/30 hover:bg-muted/30">
                  <TableCell colSpan={4} className="py-1.5 text-xs whitespace-normal">
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
                    {shared && (
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground" data-testid="coverage-group">
                        Not included: {shared}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">{formatCurrency(g.total_cost_usd)}</TableCell>
                  <TableCell />
                </TableRow>,
                ...g.keys.map((k) => (
                  <TableRow key={k.key} data-testid="key-row">
                    <TableCell>{k.providerName ?? "—"}</TableCell>
                    <TableCell className={NAME_CELL}>
                      <button
                        type="button"
                        className="text-left font-medium break-words hover:underline"
                        onClick={() => onFiltersChange({ ...data.filters, key: k.key })}
                      >
                        {k.label}
                      </button>
                      {k.provider_created_at && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="key-created">
                          created {isoDay(k.provider_created_at)}
                        </p>
                      )}
                      {!tableNote && !shared && <Coverage notes={k.coverage} unassigned={false} />}
                    </TableCell>
                    <TableCell>{k.owner ?? "—"}</TableCell>
                    <TableCell>{k.team ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(k.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <Change e={k} projection={data.projection} />
                    </TableCell>
                  </TableRow>
                )),
                ]
              })
            )}
            {unassigned.map((k) => (
              <TableRow key={k.key} data-testid="key-row">
                <TableCell>—</TableCell>
                <TableCell className={NAME_CELL}>
                  <button
                    type="button"
                    className="text-left font-medium hover:underline"
                    onClick={() => onFiltersChange({ ...data.filters, key: k.key })}
                  >
                    {UNASSIGNED_KEY_LABEL}
                  </button>
                  <Coverage notes={k.coverage} unassigned />
                </TableCell>
                <TableCell>—</TableCell>
                <TableCell>—</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(k.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <Change e={k} projection={data.projection} />
                </TableCell>
              </TableRow>
            ))}
            {empty && (
              <TableRow>
                <TableCell colSpan={6} className="py-4 text-center text-sm text-muted-foreground" data-testid="keys-empty">
                  {allKeys.length === 0 ? "No API keys for this selection." : "No keys match these filters."}
                  {!keyFilter.showAll && allKeys.length > 0 && (
                    <button type="button" className="ml-2 underline hover:text-foreground" onClick={() => setKeyFilter({ ...keyFilter, showAll: true })}>
                      Show $0 keys
                    </button>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <ConsiderRevoking
          items={revoke.map((k) => ({
            key: k.key,
            label: k.label,
            provider: k.providerName,
            owner: k.owner,
            lastSpend: k.last_spend,
            createdAt: k.provider_created_at,
          }))}
        />
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
              <TableHead className="text-right">{changeHeader(data)}</TableHead>
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
                  <Change e={p} projection={data.projection} />
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
