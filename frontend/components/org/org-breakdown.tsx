"use client"

/**
 * Org spend views (issue #8): breadcrumbs, the department -> team -> person ->
 * (provider x model) drill-down, the People table and the API keys table.
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
  type DashboardFilters,
  type DrillLevel,
} from "@/lib/dashboard-filters"
import type {
  BreakdownApiKey,
  BreakdownData,
  BreakdownEntity,
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

const visible = (e: BreakdownEntity) => e.unassigned || e.cost !== 0 || e.prevCost !== 0

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

export function ApiKeysTable({ data, onFiltersChange }: { data: BreakdownData; onFiltersChange: OnFilters }) {
  const keys = data.api_key.filter(visible) as BreakdownApiKey[]
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">API keys</CardTitle>
        <CardDescription>Spend on registered provider API keys</CardDescription>
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
            {keys.map((k) => (
              <TableRow key={k.key} data-testid="key-row">
                <TableCell>{k.providerName ?? "—"}</TableCell>
                <TableCell>
                  <button
                    type="button"
                    className="text-left font-medium hover:underline"
                    onClick={() => onFiltersChange({ ...data.filters, key: k.key })}
                  >
                    {k.unassigned ? "Unassigned (no registered key)" : k.label}
                  </button>
                  <Coverage notes={k.coverage} unassigned={k.unassigned} />
                </TableCell>
                <TableCell>{k.owner ?? "—"}</TableCell>
                <TableCell>{k.team ?? "—"}</TableCell>
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
  const teams = o?.teams.filter((t) => !filters.department || t.departmentId === filters.department) ?? []
  const people = o?.people.filter((p) => !filters.team || p.teamId === filters.team) ?? []
  const set = (k: keyof DashboardFilters, v: string) => {
    const next = { ...filters }
    if (v) next[k] = v
    else delete next[k]
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
      {field("team", "Team", teams.map((t) => ({ value: t.id, label: t.label })))}
      {field("person", "Person", people.map((p) => ({ value: p.id, label: p.label })))}
      {field("key", "API key", o?.apiKeys.map((k) => ({ value: k.id, label: k.label })) ?? [])}
      {field("provider", "Provider", o?.providers.map((p) => ({ value: p.slug, label: p.label })) ?? [], false)}
      {active && (
        <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => onFiltersChange({})}>
          Clear filters
        </button>
      )}
    </div>
  )
}

/** The Org tab: breadcrumbs, the drill-down, People and API keys. */
export function OrgBreakdown({ data, onFiltersChange }: { data: BreakdownData; onFiltersChange: OnFilters }) {
  return (
    <div className="space-y-6">
      <OrgBreadcrumbs data={data} onFiltersChange={onFiltersChange} />
      {/* At team level the People table is the drill-down (it adds per-provider columns). */}
      {data.level !== "person" && <DrilldownTable data={data} onFiltersChange={onFiltersChange} />}
      {data.level !== "detail" && <PeopleTable data={data} onFiltersChange={onFiltersChange} />}
      <ApiKeysTable data={data} onFiltersChange={onFiltersChange} />
    </div>
  )
}
