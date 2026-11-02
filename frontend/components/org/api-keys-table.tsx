"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { BreakdownEntity } from "@/lib/dashboard/breakdown"
import { changeClass, formatChange, formatCurrency } from "./format"

interface ApiKeysTableProps {
  apiKeys: BreakdownEntity[]
  onSelect?: (keyId: string) => void
}

/** Registered API keys with provider, owner, team and spend; unmatched spend is the Unassigned row. */
export function ApiKeysTable({ apiKeys, onSelect }: ApiKeysTableProps) {
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-lg">API keys</CardTitle>
        <CardDescription>Spend on registered provider keys. Unassigned is spend not on a registered key.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table data-testid="api-keys-table">
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
            {apiKeys.map((k) => (
              <TableRow key={k.key} className={k.unassigned ? "bg-muted/30" : undefined}>
                <TableCell>{k.providerName ?? ""}</TableCell>
                <TableCell>
                  {onSelect && !k.unassigned ? (
                    <button type="button" className="text-left font-medium hover:underline" onClick={() => onSelect(k.key)}>
                      {k.label}
                    </button>
                  ) : (
                    <span className="font-medium">{k.label}</span>
                  )}
                  {k.unassigned && !!k.coverageNotes?.length && (
                    <p className="mt-1 text-xs text-muted-foreground">Includes {k.coverageNotes.join("; ")}</p>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{k.unassigned ? "" : k.ownerLabel ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{k.unassigned ? "" : k.teamLabel ?? "—"}</TableCell>
                <TableCell className="text-right font-medium">{formatCurrency(k.spend)}</TableCell>
                <TableCell className={`text-right ${changeClass(k.changePercent)}`}>{formatChange(k.changePercent, k.spend)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
