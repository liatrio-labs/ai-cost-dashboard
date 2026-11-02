"use client"

import { Button } from "@/components/ui/button"
import { X } from "lucide-react"
import type { BreakdownData, BreakdownOption } from "@/lib/dashboard/breakdown"
import { hasFilters, type DashboardFilters, type FilterParam } from "@/lib/dashboard/filters"
import { UNASSIGNED_KEY, UNASSIGNED_LABEL } from "@/lib/org/rollup"

interface OrgFilterBarProps {
  options: BreakdownData["options"]
  filters: DashboardFilters
  onChange: (filters: DashboardFilters) => void
}

/** Narrower filters reset when a broader one changes. */
const CHILDREN: Partial<Record<FilterParam, FilterParam[]>> = {
  department: ["team", "person", "key"],
  team: ["person", "key"],
}

export function OrgFilterBar({ options, filters, onChange }: OrgFilterBarProps) {
  const teamIdsInDept = filters.department
    ? new Set(options.teams.filter((t) => (t.parentId ?? UNASSIGNED_KEY) === filters.department).map((t) => t.id))
    : null
  const underTeam = (o: BreakdownOption) => {
    if (filters.team) return (o.parentId ?? UNASSIGNED_KEY) === filters.team
    // Under the Unassigned department, unteamed people and keys belong too.
    if (teamIdsInDept) return o.parentId ? teamIdsInDept.has(o.parentId) : filters.department === UNASSIGNED_KEY
    return true
  }

  const set = (name: FilterParam, value: string) => {
    const next: DashboardFilters = { ...filters, [name]: value || undefined }
    for (const child of CHILDREN[name] ?? []) delete next[child]
    onChange(next)
  }

  const select = (name: FilterParam, label: string, opts: BreakdownOption[], unassigned = true) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select
        aria-label={label}
        value={filters[name] ?? ""}
        onChange={(e) => set(name, e.target.value)}
        className="h-8 min-w-[9rem] rounded-md border border-input bg-background px-2 text-sm text-foreground"
      >
        <option value="">All</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
        {unassigned && <option value={UNASSIGNED_KEY}>{UNASSIGNED_LABEL}</option>}
      </select>
    </label>
  )

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="org-filter-bar">
      {select("department", "Department", options.departments)}
      {select("team", "Team", options.teams.filter((t) => !teamIdsInDept || teamIdsInDept.has(t.id)))}
      {select("person", "Person", options.people.filter(underTeam))}
      {select("key", "API key", options.apiKeys.filter(underTeam))}
      {select("provider", "Provider", options.providers, false)}
      {hasFilters(filters) && (
        <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={() => onChange({})}>
          <X className="h-3 w-3" />
          Clear filters
        </Button>
      )}
    </div>
  )
}
