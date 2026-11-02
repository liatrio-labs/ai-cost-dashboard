/**
 * Pure builder behind GET /api/dashboard/breakdown (issue #8): spend by
 * department, team, person and API key for the active period, each level
 * with an Unassigned row, per-entity change vs the comparison window, and
 * per-provider splits with coverage notes.
 *
 * Reads cost_records_daily_attributed rows (already resolved by #5's view),
 * so it never parses metadata.attribution itself.
 */

import { buildOrgIndex } from "@/lib/org/attribution"
import { rollup, totalOf, UNASSIGNED_KEY, type RollupLevel } from "@/lib/org/rollup"
import type { AttributedDailyRow, OrgData, OrgIndex } from "@/lib/org/types"
import { buildProviderMeta, type ProviderRow } from "./aggregate"
import { canAttribute, coverageFor, coverageLabel, type ProviderCoverage } from "./coverage"
import { applyFilters, type DashboardFilters, type PeriodParams } from "./filters"
import { comparisonWindow, resolvePeriod } from "./period"

export interface BreakdownEntity {
  /** Entity id, or "unassigned". */
  key: string
  id: string | null
  label: string
  unassigned: boolean
  spend: number
  prevSpend: number
  /** null when there was no spend in the comparison window. */
  changePercent: number | null
  tokens: number
  /** provider_id -> spend in the active period. */
  byProvider: Record<string, number>
  /** Unassigned rows: providers in this bucket that can't attribute at this level. */
  coverageNotes?: string[]
  // Context for drill-down and tables (current org structure).
  departmentId?: string | null
  departmentLabel?: string | null
  teamId?: string | null
  teamLabel?: string | null
  email?: string | null
  providerId?: string | null
  providerName?: string | null
  ownerId?: string | null
  ownerLabel?: string | null
}

export interface BreakdownProvider {
  id: string
  name: string
  slug: string
  color: string
  spend: number
  coverage: ProviderCoverage
  /** e.g. "Windsurf: org-level only" */
  coverageLabel: string
  canAttribute: Record<RollupLevel, boolean>
}

export interface BreakdownDetailRow {
  providerId: string
  providerName: string
  model: string
  spend: number
  tokens: number
}

export interface BreakdownOption {
  id: string
  label: string
  parentId?: string | null
}

export interface BreakdownData {
  period: { start: string; end: string; mode: "month" | "range" }
  comparison: { start: string; end: string }
  filters: DashboardFilters
  /** False when no departments, teams, people or keys exist yet. */
  orgConfigured: boolean
  total: { spend: number; prevSpend: number; changePercent: number | null; tokens: number }
  departments: BreakdownEntity[]
  teams: BreakdownEntity[]
  people: BreakdownEntity[]
  apiKeys: BreakdownEntity[]
  /** provider x model for the filtered scope (a person's detail when filtered to one). */
  detail: BreakdownDetailRow[]
  /** Providers with spend in the filtered period, by spend. */
  providers: BreakdownProvider[]
  options: {
    departments: BreakdownOption[]
    teams: BreakdownOption[]
    people: BreakdownOption[]
    apiKeys: BreakdownOption[]
    providers: BreakdownOption[]
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export function changePercent(cur: number, prev: number): number | null {
  return prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null
}

const inWindow = (w: { start: string; end: string }) => (r: AttributedDailyRow) =>
  r.date >= w.start && r.date <= w.end

function personLabel(index: OrgIndex, id: string | null | undefined): string | null {
  if (!id) return null
  const p = index.peopleById.get(id)
  return p ? p.display_name || p.email : id
}

function levelEntities(
  level: RollupLevel,
  cur: AttributedDailyRow[],
  prev: AttributedDailyRow[],
  index: OrgIndex,
  providerSlug: (id: string) => string,
  providerName: (id: string) => string
): BreakdownEntity[] {
  const curBuckets = rollup(cur, level, index)
  const prevBuckets = rollup(prev, level, index)

  const byKey = new Map<string, BreakdownEntity>()
  const ensure = (b: (typeof curBuckets)[number]) => {
    let e = byKey.get(b.key)
    if (!e) {
      e = { key: b.key, id: b.id, label: b.label, unassigned: b.unassigned, spend: 0, prevSpend: 0, changePercent: null, tokens: 0, byProvider: {} }
      byKey.set(b.key, e)
    }
    return e
  }
  for (const b of curBuckets) {
    const e = ensure(b)
    e.spend = b.total_cost_usd
    e.tokens = b.total_tokens
  }
  for (const b of prevBuckets) ensure(b).prevSpend = b.total_cost_usd

  // Per-provider split.
  const providerIds = [...new Set(cur.map((r) => r.provider_id))]
  for (const pid of providerIds) {
    for (const b of rollup(cur.filter((r) => r.provider_id === pid), level, index)) {
      if (b.total_cost_usd !== 0) byKey.get(b.key)!.byProvider[pid] = b.total_cost_usd
    }
  }

  for (const e of byKey.values()) {
    e.changePercent = changePercent(e.spend, e.prevSpend)
    if (e.unassigned) {
      e.coverageNotes = Object.keys(e.byProvider)
        .filter((pid) => !canAttribute(providerSlug(pid), level))
        .map((pid) => coverageLabel(providerName(pid), providerSlug(pid)))
        .sort()
    } else if (e.id) {
      Object.assign(e, entityContext(level, e.id, index, providerName))
    }
  }

  const all = [...byKey.values()]
  const assigned = all
    .filter((e) => !e.unassigned)
    .sort((a, b) => b.spend - a.spend || b.prevSpend - a.prevSpend || a.label.localeCompare(b.label))
  return [...assigned, byKey.get(UNASSIGNED_KEY)!]
}

function entityContext(
  level: RollupLevel,
  id: string,
  index: OrgIndex,
  providerName: (id: string) => string
): Partial<BreakdownEntity> {
  const teamCtx = (teamId: string | null | undefined) => {
    const team = teamId ? index.teamsById.get(teamId) : undefined
    return { teamId: teamId ?? null, teamLabel: team?.name ?? null }
  }
  switch (level) {
    case "department":
      return {}
    case "team": {
      const deptId = index.teamsById.get(id)?.department_id ?? null
      return { departmentId: deptId, departmentLabel: deptId ? index.departmentsById.get(deptId)?.name ?? null : null }
    }
    case "person": {
      const p = index.peopleById.get(id)
      return { email: p?.email ?? null, ...teamCtx(p?.team_id) }
    }
    case "api_key": {
      const k = index.apiKeysById.get(id)
      return {
        providerId: k?.provider_id ?? null,
        providerName: k ? providerName(k.provider_id) : null,
        ownerId: k?.owner_person_id ?? null,
        ownerLabel: personLabel(index, k?.owner_person_id),
        ...teamCtx(k?.team_id),
      }
    }
  }
}

export function buildBreakdown(
  rows: AttributedDailyRow[],
  org: OrgData,
  providerRows: ProviderRow[],
  periodParams: PeriodParams,
  filters: DashboardFilters,
  now: Date = new Date()
): BreakdownData {
  const index = buildOrgIndex(org)
  const meta = buildProviderMeta(providerRows)
  const providerSlug = (id: string) => meta.get(id)?.slug ?? id
  const providerName = (id: string) => meta.get(id)?.name ?? "Unknown"

  const period = resolvePeriod(periodParams, now)
  const comparison = comparisonWindow(period)
  const scoped = applyFilters(rows, filters)
  const cur = scoped.filter(inWindow(period))
  const prev = scoped.filter(inWindow(comparison))

  const curTotal = totalOf(cur)
  const prevTotal = totalOf(prev)

  // Providers with spend in the filtered period.
  const providerSpend = new Map<string, number>()
  for (const r of cur) providerSpend.set(r.provider_id, (providerSpend.get(r.provider_id) ?? 0) + num(r.total_cost_usd))
  const providers: BreakdownProvider[] = [...providerSpend.entries()]
    .map(([id, spend]) => {
      const slug = providerSlug(id)
      return {
        id,
        name: providerName(id),
        slug,
        color: meta.get(id)?.color ?? "#6B7280",
        spend: round6(spend),
        coverage: coverageFor(slug),
        coverageLabel: coverageLabel(providerName(id), slug),
        canAttribute: {
          department: canAttribute(slug, "department"),
          team: canAttribute(slug, "team"),
          person: canAttribute(slug, "person"),
          api_key: canAttribute(slug, "api_key"),
        },
      }
    })
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))

  // provider x model detail.
  const detailMap = new Map<string, BreakdownDetailRow>()
  for (const r of cur) {
    const k = `${r.provider_id}|${r.model_name}`
    const d = detailMap.get(k) ?? { providerId: r.provider_id, providerName: providerName(r.provider_id), model: r.model_name, spend: 0, tokens: 0 }
    d.spend += num(r.total_cost_usd)
    d.tokens += num(r.total_tokens)
    detailMap.set(k, d)
  }
  const detail = [...detailMap.values()]
    .map((d) => ({ ...d, spend: round6(d.spend) }))
    .sort((a, b) => b.spend - a.spend || a.model.localeCompare(b.model))

  const level = (l: RollupLevel) => levelEntities(l, cur, prev, index, providerSlug, providerName)
  const byLabel = (a: BreakdownOption, b: BreakdownOption) => a.label.localeCompare(b.label)

  return {
    period: { start: period.start, end: period.end, mode: period.mode },
    comparison,
    filters,
    orgConfigured: org.departments.length + org.teams.length + org.people.length + org.apiKeys.length > 0,
    total: {
      spend: curTotal.total_cost_usd,
      prevSpend: prevTotal.total_cost_usd,
      changePercent: changePercent(curTotal.total_cost_usd, prevTotal.total_cost_usd),
      tokens: curTotal.total_tokens,
    },
    departments: level("department"),
    teams: level("team"),
    people: level("person"),
    apiKeys: level("api_key"),
    detail,
    providers,
    options: {
      departments: org.departments.map((d) => ({ id: d.id, label: d.name })).sort(byLabel),
      teams: org.teams.map((t) => ({ id: t.id, label: t.name, parentId: t.department_id })).sort(byLabel),
      people: org.people.map((p) => ({ id: p.id, label: p.display_name || p.email, parentId: p.team_id })).sort(byLabel),
      apiKeys: org.apiKeys
        .map((k) => ({ id: k.id, label: `${k.name || k.external_key_id} (${providerName(k.provider_id)})`, parentId: k.team_id }))
        .sort(byLabel),
      providers: providerRows.map((p) => ({ id: p.id, label: p.display_name || p.name })),
    },
  }
}
