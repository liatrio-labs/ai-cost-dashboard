/**
 * Monthly budgets (issue #49): projected > budget is flagged, rows map to
 * person / team / project subjects, and over-budget subjects appear in the
 * Needs-review inbox (#44). Pure; fixtures only.
 */

import { budgetState, computeBudgetStatuses, isProjectedOver, type Budget } from "./budgets"
import { computeReviewInbox } from "./org/review-inbox"
import type { AttributedDailyRow, OrgData } from "./org/types"

const NOW = new Date("2026-11-15T12:00:00Z")
const AN = "prov-an"
const OA = "prov-oa"
const providers = [
  { id: AN, name: "anthropic", display_name: "Anthropic", last_collected_at: "2026-11-15T06:00:00Z" },
  { id: OA, name: "openai", display_name: "OpenAI", last_collected_at: "2026-11-15T06:00:00Z" },
]

const org: OrgData = {
  departments: [],
  teams: [
    { id: "t1", name: "Platform", department_id: null },
    { id: "t2", name: "Quiet", department_id: null },
  ],
  people: [
    { id: "p1", email: "p1@liatrio.com", display_name: "Pat One", team_id: "t1" },
    { id: "p2", email: "p2@liatrio.com", display_name: null, team_id: "t1" },
  ],
  identities: [],
  apiKeys: [],
  projects: [{ id: "proj-1", provider_id: OA, external_project_id: "proj_ext", name: "Chatbot", team_id: null }],
}

function row(date: string, cost: number, over: Partial<AttributedDailyRow> = {}): AttributedDailyRow {
  return {
    date,
    provider_id: AN,
    model_name: "m",
    person_id: null,
    org_api_key_id: null,
    team_id: null,
    department_id: null,
    project_id: null,
    workspace_id: null,
    granularity: "person",
    total_cost_usd: cost,
    ...over,
  }
}

function daily(from: string, to: string, cost: number, over: Partial<AttributedDailyRow>): AttributedDailyRow[] {
  const out: AttributedDailyRow[] = []
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) out.push(row(d, cost, over))
  return out
}

// p1: $100/day Oct 1 - Nov 14 (Nov actual $1,400; projected ~$3,000).
// p2: $10/day (Nov actual $140; projected ~$300). Project rows: $50/day on OpenAI proj_ext.
const rows = [
  ...daily("2026-10-01", "2026-11-14", 100, { person_id: "p1", team_id: "t1" }),
  ...daily("2026-10-01", "2026-11-14", 10, { person_id: "p2", team_id: "t1" }),
  ...daily("2026-10-01", "2026-11-14", 50, { provider_id: OA, project_id: "proj_ext", granularity: "project" }),
]

const budget = (id: string, scope: Budget["scope"], subject_id: string, monthly_usd: number | string): Budget => ({ id, scope, subject_id, monthly_usd })

describe("isProjectedOver / budgetState", () => {
  test("projected > budget is flagged; equal is not", () => {
    expect(isProjectedOver(1000.01, 1000)).toBe(true)
    expect(isProjectedOver(1000, 1000)).toBe(false)
    expect(isProjectedOver(1000.004, 1000)).toBe(false)
    expect(isProjectedOver(5, 0)).toBe(false)
  })
  test("states", () => {
    expect(budgetState(1200, 3000, 1000)).toBe("over")
    expect(budgetState(500, 3000, 1000)).toBe("projected_over")
    expect(budgetState(500, 900, 1000)).toBe("ok")
  })
})

describe("computeBudgetStatuses", () => {
  const statuses = computeBudgetStatuses({
    rows,
    org,
    providers,
    now: NOW,
    budgets: [
      budget("b-p1", "person", "p1", 2000),
      budget("b-p2", "person", "p2", "1000.00"),
      budget("b-t1", "team", "t1", 1000),
      budget("b-proj", "project", "proj-1", 1000),
      budget("b-gone", "team", "deleted-team", 1),
    ],
  })
  const by = (id: string) => statuses.find((s) => s.budget.id === id)!

  test("a person projected over budget is flagged (actual still under)", () => {
    const s = by("b-p1")
    expect(s.month).toBe("2026-11")
    expect(s.actual).toBe(1400)
    expect(s.projected).toBeGreaterThan(2000)
    expect(s).toMatchObject({ state: "projected_over", projectedOver: true, subject: "person:p1", label: "Pat One", budgetUsd: 2000 })
  })

  test("under budget is not flagged; string amounts from PostgREST work", () => {
    expect(by("b-p2")).toMatchObject({ state: "ok", projectedOver: false, actual: 140, budgetUsd: 1000, label: "p2@liatrio.com" })
  })

  test("teams sum their people; already over is 'over'", () => {
    expect(by("b-t1")).toMatchObject({ state: "over", projectedOver: true, actual: 1540 })
  })

  test("projects map through org_projects by provider + external project id", () => {
    const s = by("b-proj")
    expect(s.actual).toBe(700)
    expect(s).toMatchObject({ state: "projected_over", label: "Chatbot", subject: "project:proj-1" })
  })

  test("a budget whose subject was deleted is never flagged", () => {
    expect(by("b-gone")).toMatchObject({ subjectExists: false, projectedOver: false, state: "ok" })
  })

  test("sorted: over, then projected over, then ok", () => {
    expect(statuses.map((s) => s.state)).toEqual(["over", "projected_over", "projected_over", "ok", "ok"])
  })

  test("no budgets: nothing computed", () => {
    expect(computeBudgetStatuses({ rows, org, providers, budgets: [], now: NOW })).toEqual([])
  })
})

describe("Needs-review inbox", () => {
  const budgetStatuses = computeBudgetStatuses({
    rows,
    org,
    providers,
    now: NOW,
    budgets: [budget("b-p1", "person", "p1", 2000), budget("b-p2", "person", "p2", 1000)],
  })

  test("over-budget subjects are listed as budget_over items, first", () => {
    const inbox = computeReviewInbox({ rows, org, providers, budgetStatuses, now: NOW })
    const items = inbox.items.filter((i) => i.kind === "budget_over")
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: "budget_over|person:p1|2026-11", projected: true, label: "Person: Pat One", assign: null })
    expect(items[0].detail).toMatch(/budget \$2,000\.00/)
    expect(inbox.items[0].kind).toBe("budget_over")
  })

  test("acknowledged budget items stay hidden until the projection grows > 25%", () => {
    const amount = budgetStatuses.find((s) => s.subject === "person:p1")!.projected
    const decision = { kind: "budget_over" as const, subject: "person:p1", period: "2026-11", amount, status: "acknowledged" as const, note: null, acknowledged_by: null, acknowledged_at: null }
    const inbox = computeReviewInbox({ rows, org, providers, budgetStatuses, decisions: [decision], now: NOW })
    expect(inbox.items.some((i) => i.kind === "budget_over")).toBe(false)
    expect(inbox.hiddenCount).toBeGreaterThanOrEqual(1)
  })

  test("without budgets (migration 020 not applied) there are no budget items", () => {
    const inbox = computeReviewInbox({ rows, org, providers, now: NOW })
    expect(inbox.items.some((i) => i.kind === "budget_over")).toBe(false)
  })
})
