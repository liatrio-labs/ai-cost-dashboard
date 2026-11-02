"use client"

import { ChevronRight } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { BreakdownData, BreakdownEntity } from "@/lib/dashboard/breakdown"
import type { DashboardFilters } from "@/lib/dashboard/filters"
import { UNASSIGNED_KEY, UNASSIGNED_LABEL } from "@/lib/org/rollup"
import { changeClass, formatChange, formatCurrency } from "./format"

interface OrgDrilldownProps {
  data: BreakdownData
  onNavigate: (filters: DashboardFilters) => void
}

type Step = "department" | "team" | "person"

const LEVEL_TITLE = { department: "Departments", team: "Teams", person: "People" } as const
const LEVEL_NOUN = { department: "Department", team: "Team", person: "Person" } as const

function labelOf(options: { id: string; label: string }[], id: string | undefined): string {
  if (!id) return ""
  if (id === UNASSIGNED_KEY) return UNASSIGNED_LABEL
  return options.find((o) => o.id === id)?.label ?? id
}

/**
 * Department -> teams -> people -> (provider x model) drill-down, driven by
 * the URL filters: the deepest org filter set decides which level is shown.
 */
export function OrgDrilldown({ data, onNavigate }: OrgDrilldownProps) {
  const f = data.filters
  const { provider } = f
  const keep = provider ? { provider } : {}

  // Breadcrumbs: All > department > team > person.
  const crumbs: { label: string; filters: DashboardFilters }[] = [{ label: "All departments", filters: keep }]
  if (f.department) crumbs.push({ label: labelOf(data.options.departments, f.department), filters: { ...keep, department: f.department } })
  if (f.team) crumbs.push({ label: labelOf(data.options.teams, f.team), filters: { ...keep, department: f.department, team: f.team } })
  if (f.person) crumbs.push({ label: labelOf(data.options.people, f.person), filters: { ...keep, department: f.department, team: f.team, person: f.person } })
  if (f.key) crumbs.push({ label: labelOf(data.options.apiKeys, f.key), filters: f })

  const step: Step | "detail" = f.person || f.key ? "detail" : f.team ? "person" : f.department ? "team" : "department"
  const rows: BreakdownEntity[] =
    step === "department" ? data.departments : step === "team" ? data.teams : step === "person" ? data.people : []
  const filterName = step === "department" ? "department" : step === "team" ? "team" : "person"

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
              {i === crumbs.length - 1 ? (
                <span aria-current="page" className="font-medium text-foreground">
                  {c.label}
                </span>
              ) : (
                <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => onNavigate(c.filters)}>
                  {c.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <CardTitle className="text-lg">{step === "detail" ? "Provider × model" : LEVEL_TITLE[step]}</CardTitle>
        <CardDescription>
          {formatCurrency(data.total.spend)} in this period · change vs {data.comparison.start} – {data.comparison.end}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {step === "detail" ? (
          <Table data-testid="drilldown-detail">
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.detail.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    No spend in this period
                  </TableCell>
                </TableRow>
              )}
              {data.detail.map((d) => (
                <TableRow key={`${d.providerId}|${d.model}`}>
                  <TableCell>{d.providerName}</TableCell>
                  <TableCell className="font-mono text-xs">{d.model}</TableCell>
                  <TableCell className="text-right">{formatCurrency(d.spend)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table data-testid={`drilldown-${step}`}>
            <TableHeader>
              <TableRow>
                <TableHead>{LEVEL_NOUN[step]}</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead className="w-1/3">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => {
                const share = data.total.spend > 0 ? (e.spend / data.total.spend) * 100 : 0
                return (
                  <TableRow key={e.key} className={e.unassigned ? "bg-muted/30" : undefined}>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left font-medium hover:underline"
                        onClick={() => onNavigate({ ...f, [filterName]: e.key })}
                      >
                        {e.label}
                      </button>
                      {e.unassigned && !!e.coverageNotes?.length && (
                        <p className="mt-1 text-xs text-muted-foreground">Includes {e.coverageNotes.join("; ")}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{formatCurrency(e.spend)}</TableCell>
                    <TableCell className={`text-right ${changeClass(e.changePercent)}`}>{formatChange(e.changePercent, e.spend)}</TableCell>
                    <TableCell>
                      <div className="h-2 rounded bg-muted" aria-hidden>
                        <div className="h-2 rounded bg-primary" style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
