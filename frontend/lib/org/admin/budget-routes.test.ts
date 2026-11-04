/**
 * @jest-environment node
 *
 * /api/admin/org/budgets, /api/admin/org/budgets/:id, the inbox's budget
 * items and /api/cron/budget-alerts (issue #49). With migration 020: create,
 * replace, flag projected over budget, delete. Without 020: a 200 with a
 * "migration 020 not applied" notice and 409s on writes, never a 500; the
 * cron does nothing. Mocked auth, in-memory Supabase fake; no network.
 */

import { NextRequest } from "next/server"
import { FakeSupabase, ORG_TABLE_CONFIG } from "./testing/fake-supabase"

const mockAuth = { user: null as null | { id: string; email: string } }
const mockState = { db: null as unknown }

jest.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}))
jest.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: mockAuth.user }, error: null }) },
  }),
}))
jest.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockState.db,
  refreshDailyAggregates: async () => undefined,
}))

import * as budgets from "@/app/api/admin/org/budgets/route"
import * as budgetById from "@/app/api/admin/org/budgets/[id]/route"
import * as review from "@/app/api/admin/org/review/route"
import * as cron from "@/app/api/cron/budget-alerts/route"

const ADMIN = { id: "u-admin", email: "admin@example.com" }
const AN = "prov-an"

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
async function call(handler: unknown, method: string, body?: unknown, params: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const req = new NextRequest(new URL("/api/admin/org/budgets", "http://localhost"), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
  })
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) })
  return { status: res.status, body: await res.json() }
}

function days(from: string, to: string, person: string, team: string, cost: number) {
  const out = []
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    out.push({ date: d, provider_id: AN, model_name: "m", person_id: person, org_api_key_id: null, team_id: team, department_id: null, project_id: null, workspace_id: null, granularity: "person", total_cost_usd: cost, total_tokens: 0, total_requests: 0, record_count: 1 })
  }
  return out
}

function seed() {
  return new FakeSupabase(
    {
      departments: [],
      teams: [{ id: "t1", name: "Platform", department_id: null }],
      people: [{ id: "p1", email: "p1@liatrio.com", display_name: "Pat", team_id: "t1", active: true }],
      person_identities: [],
      org_api_keys: [],
      org_projects: [{ id: "proj-1", provider_id: AN, external_project_id: "ws", name: "WS", team_id: null }],
      providers: [{ id: AN, name: "anthropic", display_name: "Anthropic", last_collected_at: "2026-11-15T06:00:00Z", documentation_url: null, metadata: null }],
      cost_records_daily_attributed: days("2026-09-01", "2026-11-14", "p1", "t1", 100),
      review_items: [],
      budgets: [],
      alert_log: [],
    },
    { ...ORG_TABLE_CONFIG, budgets: { unique: [{ columns: ["scope", "subject_id"] }] }, alert_log: { unique: [{ columns: ["subject", "period", "dry_run"] }] } }
  )
}

function without020(db: FakeSupabase) {
  const missing = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.budgets' in the schema cache" } }
  const chain: Record<string, unknown> = {}
  for (const m of ["select", "insert", "update", "delete", "eq", "single", "order", "range"]) chain[m] = () => chain
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(missing).then(ok)
  return { from: (t: string) => (t === "budgets" || t === "alert_log" ? chain : db.from(t)), rpc: db.rpc.bind(db) }
}

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
  for (const k of ["BUDGET_ALERTS_MODE", "BUDGET_ALERT_SLACK_WEBHOOK_URL", "BUDGET_ALERT_EMAIL_TO", "BUDGET_ALERT_EMAIL_FROM", "RESEND_API_KEY"]) delete process.env[k]
  process.env.CRON_SECRET = "test-cron-secret"
  jest.useFakeTimers({ now: new Date("2026-11-15T12:00:00Z"), doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "clearImmediate"] })
})
afterAll(() => {
  process.env = savedEnv
  jest.useRealTimers()
})
beforeEach(() => {
  mockAuth.user = ADMIN
  jest.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

describe("with migration 020", () => {
  test("create, replace, flag projected over budget, list in Needs review, delete", async () => {
    const db = seed()
    mockState.db = db

    const empty = await call(budgets.GET, "GET")
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({ available: true, notice: null, month: "2026-11", statuses: [], alerts: { mode: "dry_run", channels: { slack: false, email: false } } })

    const created = await call(budgets.POST, "POST", { scope: "team", subject_id: "t1", monthly_usd: 5000, note: " cap " })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ scope: "team", subject_id: "t1", monthly_usd: 5000, note: "cap", created_by: ADMIN.email })

    const replaced = await call(budgets.POST, "POST", { scope: "team", subject_id: "t1", monthly_usd: 2000 })
    expect(replaced.status).toBe(201)
    expect(db.table("budgets")).toHaveLength(1)

    const list = await call(budgets.GET, "GET")
    expect(list.body.statuses).toHaveLength(1)
    expect(list.body.statuses[0]).toMatchObject({ subject: "team:t1", label: "Platform", budgetUsd: 2000, actual: 1400, state: "projected_over", projectedOver: true })

    const inbox = await call(review.GET, "GET")
    expect(inbox.body.items.find((i: { id: string }) => i.id === "budget_over|team:t1|2026-11")).toMatchObject({ label: "Team: Platform", projected: true })

    const id = db.table("budgets")[0].id as string
    expect((await call(budgetById.DELETE, "DELETE", undefined, { id })).status).toBe(200)
    expect(db.table("budgets")).toHaveLength(0)
    expect((await call(budgetById.DELETE, "DELETE", undefined, { id })).status).toBe(404)
  })

  test("invalid bodies and unknown subjects are 400s", async () => {
    mockState.db = seed()
    expect((await call(budgets.POST, "POST", { scope: "dept", subject_id: "t1", monthly_usd: 1 })).status).toBe(400)
    expect((await call(budgets.POST, "POST", { scope: "team", subject_id: "t1", monthly_usd: 0 })).status).toBe(400)
    expect((await call(budgets.POST, "POST", { scope: "team", subject_id: "t1", monthly_usd: 10, extra: 1 })).status).toBe(400)
    const unknown = await call(budgets.POST, "POST", { scope: "person", subject_id: "nobody", monthly_usd: 10 })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toMatch(/Unknown person/)
  })

  test("admins only", async () => {
    mockState.db = seed()
    mockAuth.user = null
    expect((await call(budgets.GET, "GET")).status).toBe(401)
    mockAuth.user = { id: "u-x", email: "someone@elsewhere.test" }
    expect((await call(budgets.POST, "POST", { scope: "team", subject_id: "t1", monthly_usd: 1 })).status).toBe(403)
    expect((await call(budgetById.DELETE, "DELETE", undefined, { id: "x" })).status).toBe(403)
  })
})

describe("without migration 020", () => {
  test("GET is a 200 with the notice; writes are 409s; the inbox still works", async () => {
    mockState.db = without020(seed())
    const res = await call(budgets.GET, "GET")
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ available: false, statuses: [] })
    expect(res.body.notice).toMatch(/migration 020 not applied/i)

    const post = await call(budgets.POST, "POST", { scope: "team", subject_id: "t1", monthly_usd: 10 })
    expect(post.status).toBe(409)
    expect(post.body).toMatchObject({ code: "migration_020_not_applied" })
    const del = await call(budgetById.DELETE, "DELETE", undefined, { id: "b1" })
    expect(del.status).toBe(409)

    const inbox = await call(review.GET, "GET")
    expect(inbox.status).toBe(200)
    expect(inbox.body.items.some((i: { kind: string }) => i.kind === "budget_over")).toBe(false)
  })
})

describe("/api/cron/budget-alerts", () => {
  const auth = { authorization: "Bearer test-cron-secret" }

  test("requires CRON_SECRET", async () => {
    mockState.db = seed()
    expect((await call(cron.GET, "GET")).status).toBe(401)
    expect((await call(cron.GET, "GET", undefined, {}, { authorization: "Bearer wrong" })).status).toBe(401)
  })

  test("dry-run by default: logs, never fetches", async () => {
    const db = seed()
    db.table("budgets").push({ id: "b1", scope: "team", subject_id: "t1", monthly_usd: 2000, note: null })
    mockState.db = db
    const fetchSpy = jest.spyOn(global, "fetch")
    const res = await call(cron.GET, "GET", undefined, {}, auth)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, status: "ok", mode: "dry_run", sent: 1 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(db.table("alert_log")).toHaveLength(1)
  })

  test("without migration 020: 200 and nothing done", async () => {
    mockState.db = without020(seed())
    const res = await call(cron.GET, "GET", undefined, {}, auth)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: "migration_020_not_applied", sent: 0 })
  })
})
