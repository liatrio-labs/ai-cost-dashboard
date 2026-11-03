/**
 * Keys under their project or workspace (issue #28). Pure: shared by the
 * /admin/org "API keys & projects" view and the dashboard API keys table.
 *
 * Grouping is provider -> project/workspace -> keys:
 * - OpenAI: the key's project (attribution.project_id).
 * - Anthropic: the key's workspace (attribution.workspace_id); rows without
 *   one belong to the default workspace.
 * - Vercel AI Gateway: the key's Vercel project (org_api_keys.org_project_id,
 *   else the rows' project_id), else "No project".
 *
 * A key's group follows the attributed view's precedence: the project named
 * on its cost rows wins, then the workspace on its rows, then the project
 * assigned to the key (org_project_id). Keys with no rows (no spend yet) use
 * the assigned project only. Names come from org_projects (OpenAI projects
 * and Anthropic workspaces share that table, keyed by provider + external id),
 * else the name seen on rows, else the id.
 */

import type { OrgProject } from "./types"

export type GroupKind = "project" | "workspace"

export interface ProviderInfo {
  id: string
  name: string
  display_name?: string | null
}

interface ProviderStyle {
  kind: GroupKind
  /** Heading for a group, e.g. "Workspace". */
  noun: string
  /** Label for keys with no project / workspace. */
  none: string
}

const STYLES: Record<string, ProviderStyle> = {
  openai: { kind: "project", noun: "Project", none: "No project" },
  anthropic: { kind: "workspace", noun: "Workspace", none: "Default workspace" },
  "vercel-ai-gateway": { kind: "project", noun: "Vercel project", none: "No project" },
}
const DEFAULT_STYLE: ProviderStyle = { kind: "project", noun: "Project", none: "No project" }

export function groupStyle(providerSlug: string | null | undefined): ProviderStyle {
  return (providerSlug && STYLES[providerSlug]) || DEFAULT_STYLE
}

/** The fields groupKeys reads from a key; T carries the caller's own row data. */
export interface GroupableKey {
  provider_id: string
  external_key_id: string
  /** Project seen on the key's cost rows. */
  observed_project_id?: string | null
  /** Workspace seen on the key's cost rows. */
  observed_workspace_id?: string | null
  /** org_projects.id assigned to the key (migration 015). */
  org_project_id?: string | null
  /** Spend used for subtotals and ordering. */
  total_cost_usd: number
  name?: string | null
}

export interface ProjectGroup<T> {
  /** Stable key: provider id + ":" + external id, or provider id + ":none". */
  key: string
  /** External project / workspace id, null for the "none" group. */
  external_id: string | null
  label: string
  kind: GroupKind
  /** org_projects row, when registered. */
  registered_id: string | null
  team_id: string | null
  total_cost_usd: number
  keys: T[]
}

export interface ProviderGroup<T> {
  provider_id: string
  provider_slug: string | null
  label: string
  kind: GroupKind
  noun: string
  total_cost_usd: number
  projects: ProjectGroup<T>[]
}

export interface GroupKeysOptions {
  providers: ProviderInfo[]
  projects: OrgProject[]
  /** Names seen on cost rows, keyed provider id + ":" + external id (fallback when unregistered). */
  observedNames?: Map<string, string | null>
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6
const gkey = (providerId: string, ext: string | null) => `${providerId}:${ext ?? "none"}`

/** The external project / workspace id a key belongs to (see module doc), or null. */
export function keyProjectId(k: GroupableKey, projectsById: Map<string, OrgProject>): string | null {
  if (k.observed_project_id) return k.observed_project_id
  if (k.observed_workspace_id) return k.observed_workspace_id
  const assigned = k.org_project_id ? projectsById.get(k.org_project_id) : undefined
  return assigned && assigned.provider_id === k.provider_id ? assigned.external_project_id : null
}

/**
 * Group keys by provider, then project / workspace. Every key is kept, $0
 * ones included. Providers sort by spend then name, groups by spend with the
 * "none" group last, keys by spend then name.
 */
export function groupKeys<T extends GroupableKey>(keys: T[], opts: GroupKeysOptions): ProviderGroup<T>[] {
  const projectsById = new Map(opts.projects.map((p) => [p.id, p]))
  const projectsByExt = new Map(opts.projects.map((p) => [gkey(p.provider_id, p.external_project_id), p]))
  const providerById = new Map(opts.providers.map((p) => [p.id, p]))
  const out = new Map<string, ProviderGroup<T> & { byProject: Map<string, ProjectGroup<T>> }>()

  for (const k of keys) {
    const prov = providerById.get(k.provider_id)
    const style = groupStyle(prov?.name)
    let pg = out.get(k.provider_id)
    if (!pg) {
      pg = {
        provider_id: k.provider_id,
        provider_slug: prov?.name ?? null,
        label: prov?.display_name || prov?.name || k.provider_id,
        kind: style.kind,
        noun: style.noun,
        total_cost_usd: 0,
        projects: [],
        byProject: new Map(),
      }
      out.set(k.provider_id, pg)
    }
    const ext = keyProjectId(k, projectsById)
    const key = gkey(k.provider_id, ext)
    let group = pg.byProject.get(key)
    if (!group) {
      const reg = ext ? projectsByExt.get(key) : undefined
      group = {
        key,
        external_id: ext,
        label: ext ? reg?.name || opts.observedNames?.get(key) || ext : style.none,
        kind: style.kind,
        registered_id: reg?.id ?? null,
        team_id: reg?.team_id ?? null,
        total_cost_usd: 0,
        keys: [],
      }
      pg.byProject.set(key, group)
    }
    group.keys.push(k)
    group.total_cost_usd += k.total_cost_usd
    pg.total_cost_usd += k.total_cost_usd
  }

  const keyOrder = (a: T, b: T) =>
    b.total_cost_usd - a.total_cost_usd || (a.name || a.external_key_id).localeCompare(b.name || b.external_key_id)
  return [...out.values()]
    .map(({ byProject, ...pg }) => ({
      ...pg,
      total_cost_usd: round6(pg.total_cost_usd),
      projects: [...byProject.values()]
        .map((g) => ({ ...g, total_cost_usd: round6(g.total_cost_usd), keys: [...g.keys].sort(keyOrder) }))
        .sort(
          (a, b) =>
            Number(a.external_id === null) - Number(b.external_id === null) ||
            b.total_cost_usd - a.total_cost_usd ||
            a.label.localeCompare(b.label)
        ),
    }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd || a.label.localeCompare(b.label))
}
