"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { BreakdownData } from "@/lib/dashboard/breakdown"
import type { DashboardFilters } from "@/lib/dashboard/filters"
import { ApiKeysTable } from "./api-keys-table"
import { OrgDrilldown } from "./org-drilldown"
import { PeopleTable } from "./people-table"

interface OrgViewProps {
  data: BreakdownData
  onNavigate: (filters: DashboardFilters) => void
}

/** The "Org" tab: drill-down, People and API keys tables, and provider coverage. */
export function OrgView({ data, onNavigate }: OrgViewProps) {
  const f = data.filters
  return (
    <div className="space-y-6">
      <OrgDrilldown data={data} onNavigate={onNavigate} />
      <div className="grid gap-6 xl:grid-cols-2">
        <PeopleTable people={data.people} providers={data.providers} onSelect={(person) => onNavigate({ ...f, person })} />
        <ApiKeysTable apiKeys={data.apiKeys} onSelect={(key) => onNavigate({ ...f, key })} />
      </div>
      {data.providers.length > 0 && (
        <Card className="border-border/50 bg-card/50 backdrop-blur">
          <CardHeader>
            <CardTitle className="text-lg">Attribution coverage</CardTitle>
            <CardDescription>What each provider can attribute. Spend it can&apos;t attribute lands in Unassigned.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-sm sm:grid-cols-2" data-testid="coverage-legend">
              {data.providers.map((p) => (
                <li key={p.id}>
                  <span className="font-medium">{p.name}:</span>{" "}
                  <span className="text-muted-foreground">{p.coverage.note}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
