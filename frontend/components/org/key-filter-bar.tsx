"use client"

/**
 * Issue #45: the controls above both API keys tables (dashboard Org tab and
 * /admin/org) and the read-only "Consider revoking" list. Filtering itself
 * is lib/org/key-filter.ts.
 */

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  DEFAULT_KEY_FILTER,
  isFiltered,
  KEY_STATUS_LABEL,
  KEY_STATUSES,
  keyCountText,
  REVOKE_WINDOW_DAYS,
  type KeyFilter,
  type KeyFilterResult,
  type KeyStatus,
} from "@/lib/org/key-filter"

const chipClass = (on: boolean) =>
  cn(
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
    on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground"
  )

export function KeyFilterBar({
  filter,
  onChange,
  result,
  label = "API keys",
}: {
  filter: KeyFilter
  onChange: (f: KeyFilter) => void
  result: KeyFilterResult<unknown>
  /** Prefix for accessible names, so two bars on a page stay distinct. */
  label?: string
}) {
  const set = (patch: Partial<KeyFilter>) => onChange({ ...filter, ...patch })
  const chipTotal = KEY_STATUSES.reduce((s, k) => s + result.statusCounts[k], 0)
  // "No status" (providers that don't report one) only when it applies.
  const chips = KEY_STATUSES.filter((s) => s !== "unknown" || result.statusCounts.unknown > 0 || filter.status === "unknown")
  const chip = (value: KeyStatus | "all", text: string, count: number) => (
    <button
      key={value}
      type="button"
      className={chipClass(filter.status === value)}
      aria-pressed={filter.status === value}
      onClick={() => set({ status: value })}
    >
      {text}
      <span className="tabular-nums opacity-80">{count}</span>
    </button>
  )
  return (
    <div className="mb-3 space-y-2" role="group" aria-label={`${label} filters`}>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          aria-label={`Search ${label}`}
          placeholder="Search name, owner or id"
          className="h-8 w-full max-w-64 text-sm"
          value={filter.query}
          onChange={(e) => set({ query: e.target.value })}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={filter.showAll} onChange={(e) => set({ showAll: e.target.checked })} />
          Show $0 keys
        </label>
        <span className="text-xs text-muted-foreground" data-testid="key-count" aria-live="polite">
          {keyCountText(result, filter)}
        </span>
        {isFiltered(filter) && (
          <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => onChange(DEFAULT_KEY_FILTER)}>
            Reset
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`${label} status`}>
        {chip("all", "All", chipTotal)}
        {chips.map((s) => chip(s, KEY_STATUS_LABEL[s], result.statusCounts[s]))}
      </div>
    </div>
  )
}

/** ISO date or timestamp -> YYYY-MM-DD. */
export const isoDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null)

export interface RevokeItem {
  key: string
  label: string
  provider: string | null
  owner: string | null
  lastSpend: string | null
  /** provider_created_at (migration 018); null when unknown. */
  createdAt: string | null
}

/**
 * Active keys with $0 in the last 90 days (lib/org/key-filter
 * considerRevoking). Read-only: there is no revoke action here.
 */
export function ConsiderRevoking({ items }: { items: RevokeItem[] }) {
  if (items.length === 0) return null
  const showCreated = items.some((i) => i.createdAt)
  return (
    <details className="mt-4 rounded-md border border-dashed border-border px-3 py-2 text-xs" data-testid="consider-revoking">
      <summary className="cursor-pointer font-medium">
        Consider revoking: <span data-testid="consider-revoking-count">{items.length}</span> active key{items.length === 1 ? "" : "s"} with $0 in the
        last {REVOKE_WINDOW_DAYS} days
      </summary>
      <p className="mt-1 text-muted-foreground">Read-only. Revoke keys in the provider&apos;s console.</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left" aria-label="Consider revoking">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-normal">Key</th>
              <th className="py-1 pr-3 font-normal">Provider</th>
              <th className="py-1 pr-3 font-normal">Owner</th>
              <th className="py-1 pr-3 font-normal">Last spend</th>
              {showCreated && <th className="py-1 pr-3 font-normal">Created</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.key} data-testid="revoke-row" className="border-t border-border/50">
                <td className="py-1 pr-3 break-words">{i.label}</td>
                <td className="py-1 pr-3">{i.provider ?? "—"}</td>
                <td className="py-1 pr-3">{i.owner ?? "—"}</td>
                <td className="py-1 pr-3 tabular-nums">{isoDay(i.lastSpend) ?? "never"}</td>
                {showCreated && <td className="py-1 pr-3 tabular-nums">{isoDay(i.createdAt) ?? "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
