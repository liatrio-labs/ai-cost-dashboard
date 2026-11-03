"use client"

/** Helpers shared by the /admin/org screens (moved out of OrgAdminClient for issue #28). */

import { useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import type { KeyRow } from "@/lib/org/admin/observed"
import type { OrgSnapshot } from "@/lib/org/admin/schemas"

export type Org = OrgSnapshot

/** Run a mutation against /api/admin/org, report the result, reload. */
export type Mutate = (path: string, method: string, body?: unknown, okText?: string) => Promise<boolean>

export const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** Team <select> grouped by department; "" = none. */
export function TeamSelect({
  org,
  value,
  onChange,
  noneLabel = "Unassigned",
  ariaLabel = "Team",
}: {
  org: Org
  value: string | null
  onChange: (teamId: string | null) => void
  noneLabel?: string
  ariaLabel?: string
}) {
  const groups = useMemo(() => {
    const byDept = new Map<string, { label: string; teams: Org["teams"] }>()
    for (const t of org.teams) {
      const key = t.department_id ?? ""
      const label = org.departments.find((d) => d.id === t.department_id)?.name ?? "No department"
      const g = byDept.get(key) ?? { label, teams: [] }
      g.teams.push(t)
      byDept.set(key, g)
    }
    return [...byDept.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [org])
  return (
    <select
      aria-label={ariaLabel}
      className={selectClass}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{noneLabel}</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

/** auto = set by the AI Gateway key sync; manual = set by an admin (the sync never overwrites it). */
export function SourceBadge({ source }: { source: KeyRow["assignment_source"] }) {
  if (!source) return null
  return (
    <Badge
      variant={source === "manual" ? "secondary" : "outline"}
      className="ml-2"
      title={source === "manual" ? "Set by an admin; the key sync never overwrites it" : "Set by the key sync from the key's creator, project or workspace"}
    >
      {source}
    </Badge>
  )
}
