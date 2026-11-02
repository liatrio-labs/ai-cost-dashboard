"use client"

import { useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { BreakdownEntity, BreakdownProvider } from "@/lib/dashboard/breakdown"
import { changeClass, formatChange, formatCurrency } from "./format"

interface PeopleTableProps {
  people: BreakdownEntity[]
  providers: BreakdownProvider[]
  onSelect?: (personKey: string) => void
}

type SortKey = "spend" | "label" | string // string = provider id

/**
 * People sorted by spend, with one column per provider. A provider that
 * can't attribute spend to people shows "n/a" (with its coverage note)
 * instead of $0, so a gap isn't mistaken for no spend.
 */
export function PeopleTable({ people, providers, onSelect }: PeopleTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "spend", dir: "desc" })

  const value = (e: BreakdownEntity, key: SortKey): number | string =>
    key === "label" ? e.label.toLowerCase() : key === "spend" ? e.spend : e.byProvider[key] ?? 0
  const assigned = people
    .filter((e) => !e.unassigned)
    .sort((a, b) => {
      const va = value(a, sort.key)
      const vb = value(b, sort.key)
      const c = va < vb ? -1 : va > vb ? 1 : 0
      return sort.dir === "asc" ? c : -c
    })
  const unassigned = people.find((e) => e.unassigned)
  const rows = unassigned ? [...assigned, unassigned] : assigned

  const header = (key: SortKey, label: string, right = true) => {
    const active = sort.key === key
    return (
      <TableHead key={key} className={right ? "text-right" : undefined} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground"
          onClick={() => setSort({ key, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
        >
          {label}
          {active && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
        </button>
      </TableHead>
    )
  }

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">People</CardTitle>
        <CardDescription>Spend per person, by provider. &ldquo;n/a&rdquo; means the provider can&apos;t attribute to people.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table data-testid="people-table">
          <TableHeader>
            <TableRow>
              {header("label", "Person", false)}
              <TableHead>Team</TableHead>
              {header("spend", "Total")}
              <TableHead className="text-right">Change</TableHead>
              {providers.map((p) => header(p.id, p.name))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.key} className={e.unassigned ? "bg-muted/30" : undefined}>
                <TableCell>
                  {onSelect ? (
                    <button type="button" className="text-left font-medium hover:underline" onClick={() => onSelect(e.key)}>
                      {e.label}
                    </button>
                  ) : (
                    <span className="font-medium">{e.label}</span>
                  )}
                  {e.email && e.email !== e.label && <p className="text-xs text-muted-foreground">{e.email}</p>}
                </TableCell>
                <TableCell className="text-muted-foreground">{e.teamLabel ?? (e.unassigned ? "" : "—")}</TableCell>
                <TableCell className="text-right font-medium">{formatCurrency(e.spend)}</TableCell>
                <TableCell className={`text-right ${changeClass(e.changePercent)}`}>{formatChange(e.changePercent, e.spend)}</TableCell>
                {providers.map((p) => {
                  const v = e.byProvider[p.id]
                  if (!e.unassigned && !p.canAttribute.person) {
                    return (
                      <TableCell key={p.id} className="text-right text-xs text-muted-foreground" title={p.coverageLabel}>
                        n/a
                      </TableCell>
                    )
                  }
                  return (
                    <TableCell key={p.id} className="text-right">
                      {v ? formatCurrency(v) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
