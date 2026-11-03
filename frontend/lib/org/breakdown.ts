/**
 * Org spend breakdown for the dashboard (issue #8): spend by department, team,
 * person, API key and project (issue #24) for a period, each with an Unassigned row, the change vs
 * the previous period per entity, per-provider splits and provider coverage
 * notes. Pure: GET /api/dashboard/breakdown feeds it cost_records_daily_attributed
 * rows and org tables; tests feed it fixtures.
 *
 * Invariant: at every level, the rows (Unassigned included) sum to `total`.
 */

import {
  buildProviderMeta,
  monthBounds,
  previousWindow,
  resolvePeriod,
  type PeriodParams,
  type ProviderRow,
} from "@/lib/dashboard-compute"
import {
  applyFilters,
  drillLevel,
  effectiveProjectId,
  FILTER_KEYS,
  hasFilters,
  UNASSIGNED_FILTER,
  type DashboardFilters,
  type DrillLevel,
  type FilterKey,
} from "@/lib/dashboard-filters"
import { buildOrgIndex } from "./attribution"
import { groupKeys, keyProjectId, type ProviderGroup } from "./key-groups"
import { canAttribute, coverageFor, type CoverageLevel, type CoverageSupport } from "./coverage"
import { rollup, UNASSIGNED_LABEL, type RollupLevel } from "./rollup"
import type { AttributedDailyRow, OrgData, OrgIndex } from "./types"

export interface CoverageNote {
  provider: string // slug
  providerName: string
  note: string
}

export interface BreakdownEntity {
  key: string
  id: string | null
  label: string
  unassigned: boolean
  cost: number
  prevCost: number
  /** Percent change vs the comparison period; null when there was no prior spend. */
  changePercent: number | null
  tokens: number
  /** provider slug -> cost */
  byProvider: Record<string, number>
  /**
   * Assigned rows: providers with spend this period that can't attribute at
   * this level (their spend is not in this row). Unassigned row: the providers
   * whose spend landed here and why.
   */
  coverage: CoverageNote[]
}

export interface BreakdownApiKey extends BreakdownEntity {
  provider: string | null
  providerName: string | null
  owner: string | null
  team: string | null
}

/**
 * Spend by project (the attributed view's project_id: row project, else the
 * key's project), with Anthropic workspaces beside them (issue #28).
 */
export interface BreakdownProject {
  /** External project / workspace id, or "unassigned"; also the `project` filter value. */
  key: string
  id: string | null
  label: string
  unassigned: boolean
  /** "workspace" for Anthropic workspace ids, else "project". */
  kind: "project" | "workspace"
  provider: string | null
  providerName: string | null
  team: string | null
  cost: number
  prevCost: number
  changePercent: number | null
  tokens: number
}

/** A registered key in the keys-under-projects view (issue #28). */
export interface BreakdownKeyItem extends BreakdownApiKey {
  provider_id: string
  external_key_id: string
  /** Project / workspace from the key's rows, when any. */
  observed_project_id: string | null
  org_project_id: string | null
  /** = cost, for grouping. */
  total_cost_usd: number
  name: string | null
}

export interface BreakdownDetail {
  provider: string
  providerName: string
  model: string
  cost: number
  tokens: number
  requests: number
}

export interface BreakdownProvider {
  slug: string
  name: string
  color: string
  note: string
  person: CoverageSupport
  apiKey: boolean
}

export interface BreakdownCrumb {
  key: FilterKey
  value: string
  label: string
}

export interface BreakdownOptions {
  departments: { id: string; label: string }[]
  teams: { id: string; label: string; departmentId: string | null }[]
  people: {
    id: string
    label: string
    teamId: string | null
    /**
     * Teams / departments ("unassigned" for none) this person has spend in for
     * the period, plus their home team. Spend can sit on an API key's team, so
     * home team alone isn't enough to tell whether person + team can match.
     */
    teamIds: string[]
    departmentIds: string[]
  }[]
  apiKeys: { id: string; label: string; provider: string | null }[]
  /** Projects with spend in the period plus registered ones; id is the external project id. */
  projects: { id: string; label: string; provider: string | null }[]
  providers: { slug: string; label: string }[]
}

export interface BreakdownData {
  period: { start: string; end: string; mode: "month" | "range"; selectedMonth: string | null }
  comparePeriod: { start: string; end: string }
  filters: DashboardFilters
  level: DrillLevel
  orgConfigured: boolean
  total: { cost: number; prevCost: number; changePercent: number | null }
  department: BreakdownEntity[]
  team: BreakdownEntity[]
  person: BreakdownEntity[]
  api_key: BreakdownApiKey[]
  /**
   * Registered keys grouped by provider, then project / workspace (issue #28).
   * Keys with no spend are listed when no filter other than project / provider
   * is set; a project filter keeps only that project's keys.
   */
  key_groups: ProviderGroup<BreakdownKeyItem>[]
  project: BreakdownProject[]
  /** True when any provider reports a project or workspace on its loaded rows (issue #28). */
  hasProjects: boolean
  /** provider x model for the filtered rows (the drill-down leaf). */
  detail: BreakdownDetail[]
  /** Providers with spend in the period (before org filters), with coverage. */
  providers: BreakdownProvider[]
  breadcrumbs: BreakdownCrumb[]
  options: BreakdownOptions
}

export interface ComputeBreakdownInput {
  rows: AttributedDailyRow[]
  org: OrgData
  providers: ProviderRow[]
  filters: DashboardFilters
  params: PeriodParams
  now?: Date
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round6 = (n: number) => Math.round(n * 1e6) / 1e6
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export function pctChange(cur: number, prev: number): number | null {
  if (!(prev > 0)) return null
  return Math.round(((cur - prev) / prev) * 1000) / 10
}

/** Month mode compares with the previous calendar month; ranges with the preceding equal-length window. */
export function comparisonPeriod(p: { start: string; end: string; mode: "month" | "range" }) {
  if (p.mode === "month") {
    const [y, m] = p.start.split("-").map(Number)
    const d = new Date(Date.UTC(y, m - 2, 1))
    return monthBounds(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  return previousWindow(p.start, p.end)
}

const ID_FIELD = {
  department: "department_id",
  team: "team_id",
  person: "person_id",
  api_key: "org_api_key_id",
} as const

function byProviderAt(rows: AttributedDailyRow[], level: RollupLevel, slugOf: (id: string) => string) {
  const out = new Map<string, Record<string, number>>() // entity key -> slug -> cost
  for (const r of rows) {
    const key = r[ID_FIELD[level]] ?? UNASSIGNED_FILTER
    const slug = slugOf(r.provider_id)
    const m = out.get(key) ?? {}
    m[slug] = (m[slug] ?? 0) + num(r.total_cost_usd)
    out.set(key, m)
  }
  return out
}

function entitiesAt(
  level: RollupLevel,
  cur: AttributedDailyRow[],
  prev: AttributedDailyRow[],
  index: OrgIndex,
  slugOf: (id: string) => string,
  activeProviders: BreakdownProvider[]
): BreakdownEntity[] {
  const curB = rollup(cur, level, index)
  const prevB = rollup(prev, level, index)
  const prevByKey = new Map(prevB.map((b) => [b.key, b]))
  const split = byProviderAt(cur, level, slugOf)

  // Entities with prior spend but none now still show (a drop to $0 is news).
  const seen = new Set(curB.map((b) => b.key))
  const dropped = prevB.filter((b) => !seen.has(b.key)).map((b) => ({ ...b, total_cost_usd: 0, total_tokens: 0 }))
  const assigned = [...curB.filter((b) => !b.unassigned), ...dropped.filter((b) => !b.unassigned)]
  const unassigned = curB.find((b) => b.unassigned)!

  const covLevel: CoverageLevel = level
  const gaps: CoverageNote[] = activeProviders
    .filter((p) => !canAttribute(p.slug, covLevel))
    .map((p) => ({ provider: p.slug, providerName: p.name, note: p.note }))

  return [...assigned, unassigned].map((b) => {
    const prevCost = round2(prevByKey.get(b.key)?.total_cost_usd ?? 0)
    const cost = round2(b.total_cost_usd)
    const byProvider = Object.fromEntries(
      Object.entries(split.get(b.key) ?? {}).map(([slug, c]) => [slug, round2(c)])
    )
    const coverage = b.unassigned
      ? Object.keys(byProvider)
          .sort((a, z) => byProvider[z] - byProvider[a])
          .map((slug) => {
            const p = activeProviders.find((x) => x.slug === slug)
            return { provider: slug, providerName: p?.name ?? slug, note: coverageFor(slug).note }
          })
      : gaps
    return {
      key: b.key,
      id: b.id,
      label: b.label,
      unassigned: b.unassigned,
      cost,
      prevCost,
      changePercent: pctChange(b.total_cost_usd, prevByKey.get(b.key)?.total_cost_usd ?? 0),
      tokens: b.total_tokens,
      byProvider,
      coverage,
    }
  })
}

function projectEntities(
  cur: AttributedDailyRow[],
  prev: AttributedDailyRow[],
  org: OrgData,
  index: OrgIndex,
  slugOf: (id: string) => string,
  nameOf: (id: string) => string
): BreakdownProject[] {
  type Acc = { cost: number; prev: number; tokens: number; providerId: string | null; workspace: boolean }
  const acc = new Map<string, Acc>()
  const add = (rows: AttributedDailyRow[], field: "cost" | "prev") => {
    for (const r of rows) {
      const pid = effectiveProjectId(r)
      const key = pid || UNASSIGNED_FILTER
      const a = acc.get(key) ?? { cost: 0, prev: 0, tokens: 0, providerId: null, workspace: false }
      a[field] += num(r.total_cost_usd)
      if (field === "cost") a.tokens += num(r.total_tokens)
      if (pid) a.providerId ??= r.provider_id
      if (!r.project_id && r.workspace_id) a.workspace = true
      acc.set(key, a)
    }
  }
  add(cur, "cost")
  add(prev, "prev")
  if (!acc.has(UNASSIGNED_FILTER)) acc.set(UNASSIGNED_FILTER, { cost: 0, prev: 0, tokens: 0, providerId: null, workspace: false })

  const out = [...acc].map(([key, a]): BreakdownProject => {
    const unassigned = key === UNASSIGNED_FILTER
    const reg = unassigned
      ? undefined
      : ((a.providerId ? index.projects?.get(`${a.providerId}\u0000${key}`) : undefined) ??
        (org.projects ?? []).find((p) => p.external_project_id === key))
    const team = reg?.team_id ? index.teamsById.get(reg.team_id)?.name ?? null : null
    return {
      key,
      id: reg?.id ?? null,
      label: unassigned ? UNASSIGNED_LABEL : reg?.name || key,
      unassigned,
      kind: a.workspace ? "workspace" : "project",
      provider: a.providerId ? slugOf(a.providerId) : null,
      providerName: a.providerId ? nameOf(a.providerId) : null,
      team,
      cost: round2(a.cost),
      prevCost: round2(a.prev),
      changePercent: pctChange(a.cost, a.prev),
      tokens: a.tokens,
    }
  })
  const assigned = out.filter((e) => !e.unassigned).sort((x, y) => y.cost - x.cost || x.label.localeCompare(y.label))
  return [...assigned, out.find((e) => e.unassigned)!]
}

export function computeBreakdown({ rows, org, providers, filters, params, now = new Date() }: ComputeBreakdownInput): BreakdownData {
  const index = buildOrgIndex(org)
  const meta = buildProviderMeta(providers)
  const slugOf = (id: string) => meta.get(id)?.slug ?? id
  const nameOf = (id: string) => meta.get(id)?.name ?? id
  const providerIdForFilter = filters.provider
    ? (providers.find((p) => p.name === filters.provider)?.id ?? null)
    : null

  const resolved = resolvePeriod(params, now)
  const period = { start: resolved.start, end: resolved.end, mode: resolved.mode, selectedMonth: resolved.selectedMonth }
  const compare = comparisonPeriod(period)
  const inWindow = (w: { start: string; end: string }) => (r: AttributedDailyRow) => r.date >= w.start && r.date <= w.end

  // Coverage notes use providers active org-wide (after only the provider
  // filter): a team view must still say "Windsurf: org-level only" even though
  // Windsurf rows never carry a team.
  const providerScoped = applyFilters(rows, { provider: filters.provider }, providerIdForFilter)

  // Where each person's spend actually lands this period (feeds the filter bar).
  const spendScope = new Map<string, { teams: Set<string>; departments: Set<string> }>()
  for (const r of providerScoped) {
    if (!r.person_id || r.date < period.start || r.date > period.end) continue
    const s = spendScope.get(r.person_id) ?? { teams: new Set<string>(), departments: new Set<string>() }
    s.teams.add(r.team_id ?? UNASSIGNED_FILTER)
    s.departments.add(r.department_id ?? UNASSIGNED_FILTER)
    spendScope.set(r.person_id, s)
  }
  const activeIds = new Set(providerScoped.filter(inWindow(period)).filter((r) => num(r.total_cost_usd) !== 0).map((r) => r.provider_id))
  const activeProviders: BreakdownProvider[] = providers
    .filter((p) => activeIds.has(p.id))
    .map((p) => {
      const c = coverageFor(p.name)
      return { slug: p.name, name: nameOf(p.id), color: meta.get(p.id)!.color, note: c.note, person: c.person, apiKey: c.api_key }
    })

  const filtered = applyFilters(rows, filters, providerIdForFilter)
  const cur = filtered.filter(inWindow(period))
  const prev = filtered.filter(inWindow(compare))

  const total = cur.reduce((s, r) => s + num(r.total_cost_usd), 0)
  const prevTotal = prev.reduce((s, r) => s + num(r.total_cost_usd), 0)

  const department = entitiesAt("department", cur, prev, index, slugOf, activeProviders)
  const team = entitiesAt("team", cur, prev, index, slugOf, activeProviders)
  const person = entitiesAt("person", cur, prev, index, slugOf, activeProviders)
  const api_key: BreakdownApiKey[] = entitiesAt("api_key", cur, prev, index, slugOf, activeProviders).map((e) => {
    const k = e.id ? index.apiKeysById.get(e.id) : undefined
    const owner = k?.owner_person_id ? index.peopleById.get(k.owner_person_id) : undefined
    const keyTeam = k?.team_id ? index.teamsById.get(k.team_id) : undefined
    return {
      ...e,
      provider: k ? slugOf(k.provider_id) : null,
      providerName: k ? nameOf(k.provider_id) : null,
      owner: owner ? owner.display_name || owner.email : null,
      team: keyTeam?.name ?? null,
    }
  })

  const project = projectEntities(cur, prev, org, index, slugOf, nameOf)
  const key_groups = keyGroups({ api_key, org, index, cur, prev, providerScoped, providers, filters, providerIdForFilter, slugOf, nameOf })
  const hasProjects = providerScoped.some((r) => !!effectiveProjectId(r))

  // provider x model detail for whatever the filters select.
  const detailMap = new Map<string, BreakdownDetail>()
  for (const r of cur) {
    const k = `${r.provider_id}\u0000${r.model_name}`
    const d = detailMap.get(k) ?? { provider: slugOf(r.provider_id), providerName: nameOf(r.provider_id), model: r.model_name, cost: 0, tokens: 0, requests: 0 }
    d.cost += num(r.total_cost_usd)
    d.tokens += num(r.total_tokens)
    d.requests += num(r.total_requests)
    detailMap.set(k, d)
  }
  const detail = [...detailMap.values()]
    .map((d) => ({ ...d, cost: round2(d.cost) }))
    .sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model))

  const labelFor = (k: FilterKey, v: string): string => {
    if (k === "provider") return providers.find((p) => p.name === v) ? nameOf(providers.find((p) => p.name === v)!.id) : v
    if (v === UNASSIGNED_FILTER) return UNASSIGNED_LABEL
    if (k === "department") return index.departmentsById.get(v)?.name ?? v
    if (k === "team") return index.teamsById.get(v)?.name ?? v
    if (k === "person") {
      const p = index.peopleById.get(v)
      return p?.display_name || p?.email || v
    }
    if (k === "project") return (org.projects ?? []).find((p) => p.external_project_id === v)?.name || v
    const key = index.apiKeysById.get(v)
    return key?.name || key?.external_key_id || v
  }
  const breadcrumbs: BreakdownCrumb[] = FILTER_KEYS.filter((k) => filters[k]).map((k) => ({
    key: k,
    value: filters[k]!,
    label: labelFor(k, filters[k]!),
  }))

  return {
    period,
    comparePeriod: compare,
    filters: hasFilters(filters) ? filters : {},
    level: drillLevel(filters),
    orgConfigured: org.departments.length + org.teams.length + org.people.length + org.apiKeys.length > 0,
    total: { cost: round2(round6(total)), prevCost: round2(round6(prevTotal)), changePercent: pctChange(total, prevTotal) },
    department,
    team,
    person,
    api_key,
    key_groups,
    project,
    hasProjects,
    detail,
    providers: activeProviders,
    breadcrumbs,
    options: {
      departments: org.departments.map((d) => ({ id: d.id, label: d.name })),
      teams: org.teams.map((t) => ({ id: t.id, label: t.name, departmentId: t.department_id })),
      people: org.people.map((p) => {
        const seen = spendScope.get(p.id)
        const homeDept = p.team_id ? (index.teamsById.get(p.team_id)?.department_id ?? null) : null
        const teamIds = new Set(seen?.teams ?? [])
        const departmentIds = new Set(seen?.departments ?? [])
        teamIds.add(p.team_id ?? UNASSIGNED_FILTER)
        departmentIds.add(homeDept ?? UNASSIGNED_FILTER)
        return { id: p.id, label: p.display_name || p.email, teamId: p.team_id, teamIds: [...teamIds], departmentIds: [...departmentIds] }
      }),
      apiKeys: org.apiKeys.map((k) => ({ id: k.id, label: k.name || k.external_key_id, provider: slugOf(k.provider_id) })),
      projects: projectOptions(org, providerScoped, slugOf),
      providers: providers.map((p) => ({ slug: p.name, label: nameOf(p.id) })),
    },
  }
}

/** Registered projects plus any project id with spend in the provider-scoped rows. */
function projectOptions(org: OrgData, rows: AttributedDailyRow[], slugOf: (id: string) => string) {
  const out = new Map<string, { id: string; label: string; provider: string | null }>()
  for (const p of org.projects ?? []) {
    out.set(p.external_project_id, { id: p.external_project_id, label: p.name || p.external_project_id, provider: slugOf(p.provider_id) })
  }
  for (const r of rows) {
    // Anthropic workspaces filter like projects (issue #28).
    const pid = effectiveProjectId(r)
    if (pid && !out.has(pid)) out.set(pid, { id: pid, label: pid, provider: slugOf(r.provider_id) })
  }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Registered keys grouped under their project / workspace (issue #28). Spend
 * comes from the filtered period rows (the api_key entities); a key's project
 * is the one carrying most of its spend in the loaded rows, else its assigned
 * project. $0 keys are listed only when no org filter other than project is
 * set (person / team / department / key filters can't place a key with no
 * spend), and a project filter keeps only that project's keys.
 */
function keyGroups(input: {
  api_key: BreakdownApiKey[]
  org: OrgData
  index: OrgIndex
  cur: AttributedDailyRow[]
  prev: AttributedDailyRow[]
  providerScoped: AttributedDailyRow[]
  providers: ProviderRow[]
  filters: DashboardFilters
  providerIdForFilter: string | null
  slugOf: (id: string) => string
  nameOf: (id: string) => string
}): ProviderGroup<BreakdownKeyItem>[] {
  const { api_key, org, index, cur, prev, providerScoped, providers, filters, providerIdForFilter, slugOf, nameOf } = input
  // key id -> project -> cost, preferring the period's rows over all loaded rows.
  const projectByKey = (rows: AttributedDailyRow[]) => {
    const acc = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const pid = effectiveProjectId(r)
      if (!r.org_api_key_id || !pid) continue
      const m = acc.get(r.org_api_key_id) ?? new Map<string, number>()
      m.set(pid, (m.get(pid) ?? 0) + Math.abs(num(r.total_cost_usd)))
      acc.set(r.org_api_key_id, m)
    }
    const out = new Map<string, string>()
    for (const [k, m] of acc) out.set(k, [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0])
    return out
  }
  // This period's filtered rows first, then the comparison period's (so under
  // a project filter an active key is always placed in that project), then
  // any loaded row.
  const inPeriod = projectByKey(cur)
  const inCompare = projectByKey(prev)
  const anyTime = projectByKey(providerScoped)
  const entityById = new Map(api_key.filter((e) => e.id).map((e) => [e.id!, e]))
  const onlyProjectFilter = !filters.department && !filters.team && !filters.person && !filters.key
  const projectsById = index.projectsById ?? new Map((org.projects ?? []).map((p) => [p.id, p]))

  const items: BreakdownKeyItem[] = []
  for (const k of org.apiKeys) {
    if (filters.provider && k.provider_id !== providerIdForFilter) continue
    const e = entityById.get(k.id)
    const hasActivity = !!e && (e.cost !== 0 || e.prevCost !== 0)
    if (!hasActivity && !onlyProjectFilter) continue
    const owner = k.owner_person_id ? index.peopleById.get(k.owner_person_id) : undefined
    const item: BreakdownKeyItem = {
      key: k.id,
      id: k.id,
      label: k.name || k.external_key_id,
      unassigned: false,
      cost: e?.cost ?? 0,
      prevCost: e?.prevCost ?? 0,
      changePercent: e?.changePercent ?? null,
      tokens: e?.tokens ?? 0,
      byProvider: e?.byProvider ?? {},
      coverage: e?.coverage ?? [],
      provider: slugOf(k.provider_id),
      providerName: nameOf(k.provider_id),
      owner: owner ? owner.display_name || owner.email : null,
      team: k.team_id ? (index.teamsById.get(k.team_id)?.name ?? null) : null,
      provider_id: k.provider_id,
      external_key_id: k.external_key_id,
      observed_project_id: inPeriod.get(k.id) ?? inCompare.get(k.id) ?? anyTime.get(k.id) ?? null,
      org_project_id: k.org_project_id ?? null,
      total_cost_usd: e?.cost ?? 0,
      name: k.name ?? null,
    }
    if (filters.project) {
      const pid = keyProjectId(item, projectsById)
      if (filters.project === UNASSIGNED_FILTER ? pid !== null : pid !== filters.project) continue
    }
    items.push(item)
  }
  return groupKeys(items, { providers: providers.map((p) => ({ id: p.id, name: p.name, display_name: nameOf(p.id) })), projects: org.projects ?? [] })
}
