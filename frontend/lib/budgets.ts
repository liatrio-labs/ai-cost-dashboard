/**
 * Monthly budgets (issue #49). Pure: callers pass cost_records_daily_attributed
 * rows, the org, providers and the budgets table (migration 020); tests pass
 * fixtures.
 *
 * A budget is a monthly USD amount for one person, team or project. Its
 * subject's current-month spend is projected with the #39 projection
 * (lib/projection.ts) and flagged:
 *
 *   over            actual month-to-date spend > budget
 *   projected_over  projected month total > budget (actual still under)
 *   ok              projected <= budget
 *
 * Rows map to subjects the same way the dashboard filters do: person_id,
 * team_id, and project = the row's provider + effective project id
 * (project_id, else workspace_id) looked up in org_projects.
 */

import { effectiveProjectId } from "@/lib/dashboard-filters"
import { monthRange, projectByKey, projectionContext, projectionWindowStart, type ProjectionProvider } from "@/lib/projection"
import type { AttributedDailyRow, OrgData } from "@/lib/org/types"

export const BUDGET_SCOPES = ["person", "team", "project"] as const
export type BudgetScope = (typeof BUDGET_SCOPES)[number]

/** A budgets row (migration 020). Numeric columns may arrive as strings from PostgREST. */
export interface Budget {
  id: string
  scope: BudgetScope
  subject_id: string
  monthly_usd: number | string
  note?: string | null
  created_by?: string | null
  updated_by?: string | null
  updated_at?: string | null
}

export type BudgetState = "over" | "projected_over" | "ok"

export interface BudgetStatus {
  budget: Budget
  /** `${scope}:${subject_id}`: the alert_log / review_items subject. */
  subject: string
  label: string
  /** False when the person / team / project no longer exists (never flagged). */
  subjectExists: boolean
  month: string
  budgetUsd: number
  actual: number
  projected: number
  /** projected / budget, 0.01 precision. */
  ratio: number
  state: BudgetState
  /** projected > budget (state over or projected_over). */
  projectedOver: boolean
}

export interface BudgetInput {
  rows: AttributedDailyRow[]
  org: OrgData
  providers: ProjectionProvider[]
  budgets: Budget[]
  now?: Date
}

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export const budgetSubject = (scope: BudgetScope, id: string) => `${scope}:${id}`

/** First date of rows computeBudgetStatuses needs: the projection's trailing window and last month's seats. */
export function budgetWindowStart(providers: ProjectionProvider[], now: Date): string {
  const ctx = projectionContext(providers, now)
  return projectionWindowStart(monthRange(ctx.today.slice(0, 7)), ctx)
}

/** The org project id a row belongs to, or null. */
function projectIdOf(r: AttributedDailyRow, projects: Map<string, string>): string | null {
  const pid = effectiveProjectId(r)
  return pid ? (projects.get(`${r.provider_id}\u0000${pid}`) ?? null) : null
}

/** Is the projection over the budget? Compared in cents so $1,000.004 isn't "over" $1,000. */
export function isProjectedOver(projected: number, budgetUsd: number): boolean {
  return budgetUsd > 0 && round2(projected) > round2(budgetUsd)
}

export function budgetState(actual: number, projected: number, budgetUsd: number): BudgetState {
  if (budgetUsd > 0 && round2(actual) > round2(budgetUsd)) return "over"
  if (isProjectedOver(projected, budgetUsd)) return "projected_over"
  return "ok"
}

export function computeBudgetStatuses({ rows, org, providers, budgets, now = new Date() }: BudgetInput): BudgetStatus[] {
  if (!budgets.length) return []
  const ctx = projectionContext(providers, now)
  const month = ctx.today.slice(0, 7)
  const period = monthRange(month)

  const projects = new Map((org.projects ?? []).map((p) => [`${p.provider_id}\u0000${p.external_project_id}`, p.id]))
  const keyOf: Record<BudgetScope, (r: AttributedDailyRow) => string | null> = {
    person: (r) => r.person_id,
    team: (r) => r.team_id,
    project: (r) => projectIdOf(r, projects),
  }
  const wanted = new Set(budgets.map((b) => b.scope))
  const byScope = new Map<BudgetScope, ReturnType<typeof projectByKey>>()
  const actualByScope = new Map<BudgetScope, Map<string, number>>()
  for (const scope of wanted) {
    const key = keyOf[scope]
    const scoped = rows.filter((r) => r.date <= ctx.today && key(r) !== null)
    byScope.set(scope, projectByKey(scoped, (r) => key(r)!, period, ctx))
    const actual = new Map<string, number>()
    for (const r of scoped) {
      if (r.date < period.start) continue
      const k = key(r)!
      actual.set(k, (actual.get(k) ?? 0) + num(r.total_cost_usd))
    }
    actualByScope.set(scope, actual)
  }

  const labels: Record<BudgetScope, Map<string, string>> = {
    person: new Map(org.people.map((p) => [p.id, p.display_name || p.email])),
    team: new Map(org.teams.map((t) => [t.id, t.name])),
    project: new Map((org.projects ?? []).map((p) => [p.id, p.name || p.external_project_id])),
  }

  const out: BudgetStatus[] = budgets.map((budget) => {
    const label = labels[budget.scope].get(budget.subject_id)
    const subjectExists = label !== undefined
    const budgetUsd = round2(num(budget.monthly_usd))
    const proj = byScope.get(budget.scope)?.get(budget.subject_id)
    const actual = round2(proj?.actual ?? actualByScope.get(budget.scope)?.get(budget.subject_id) ?? 0)
    const projected = round2(proj?.projected ?? actual)
    const state = subjectExists ? budgetState(actual, projected, budgetUsd) : "ok"
    return {
      budget,
      subject: budgetSubject(budget.scope, budget.subject_id),
      label: label ?? `${budget.scope} ${budget.subject_id} (deleted)`,
      subjectExists,
      month,
      budgetUsd,
      actual,
      projected,
      ratio: budgetUsd > 0 ? Math.round((projected / budgetUsd) * 100) / 100 : 0,
      state,
      projectedOver: state !== "ok",
    }
  })
  const order: Record<BudgetState, number> = { over: 0, projected_over: 1, ok: 2 }
  return out.sort((a, b) => order[a.state] - order[b.state] || b.ratio - a.ratio || a.label.localeCompare(b.label))
}
