/**
 * @jest-environment node
 *
 * Budget / spike alerts (issue #49): dry-run by default, configured by env var
 * names only, no send when the webhook is unset, at most one alert per subject
 * per month (alert_log dedupe), and a failed send is retried next run.
 * fetch is always a jest mock; nothing reaches Slack or email.
 */

import { alertConfig, buildAlertCandidates, deliver, ALERT_ENV, RESEND_ENDPOINT, type AlertCandidate, type FetchLike } from "./budget-alerts"
import { runBudgetAlerts } from "./org/admin/alert-run"
import { FakeSupabase, ORG_TABLE_CONFIG } from "./org/admin/testing/fake-supabase"
import type { BudgetStatus } from "./budgets"
import type { ReviewItem } from "./org/review-inbox"
import type { SupabaseClient } from "@supabase/supabase-js"

const NOW = new Date("2026-11-15T12:00:00Z")
const HOOK = "https://hooks.slack.test/services/T000/B000/XXXX"
const LIVE_SLACK = { [ALERT_ENV.mode]: "live", [ALERT_ENV.slackWebhook]: HOOK }

const okFetch = () => jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => ({ ok: true, status: 200 }))

describe("alertConfig", () => {
  test("dry-run by default; nothing configured", () => {
    const c = alertConfig({})
    expect(c.summary).toEqual({ mode: "dry_run", channels: { slack: false, email: false }, env: ALERT_ENV })
  })

  test("only 'live' turns on sending", () => {
    expect(alertConfig({ [ALERT_ENV.mode]: "LIVE" }).summary.mode).toBe("live")
    expect(alertConfig({ [ALERT_ENV.mode]: "true" }).summary.mode).toBe("dry_run")
  })

  test("email needs TO, FROM and the API key; the summary never holds values", () => {
    const env = { [ALERT_ENV.slackWebhook]: HOOK, [ALERT_ENV.emailTo]: "a@x.test, b@x.test", [ALERT_ENV.emailFrom]: "alerts@x.test" }
    expect(alertConfig(env).summary.channels).toEqual({ slack: true, email: false })
    const full = alertConfig({ ...env, [ALERT_ENV.resendKey]: "re_secret_value" })
    expect(full.summary.channels).toEqual({ slack: true, email: true })
    const serialized = JSON.stringify(full)
    expect(serialized).not.toContain(HOOK)
    expect(serialized).not.toContain("re_secret_value")
    expect(serialized).not.toContain("a@x.test")
  })
})

const status = (subject: string, over: Partial<BudgetStatus> = {}): BudgetStatus => {
  const [scope, id] = subject.split(":") as [BudgetStatus["budget"]["scope"], string]
  return {
    budget: { id: `b-${id}`, scope, subject_id: id, monthly_usd: 1000 },
    subject,
    label: id,
    subjectExists: true,
    month: "2026-11",
    budgetUsd: 1000,
    actual: 600,
    projected: 1500,
    ratio: 1.5,
    state: "projected_over",
    projectedOver: true,
    ...over,
  }
}
const spike = (person: string, period: string): ReviewItem => ({
  id: `person_spike|${person}|${period}`,
  kind: "person_spike",
  subject: person,
  period,
  amount: 2400,
  projected: true,
  previousAmount: 800,
  ratio: 3,
  label: person,
  detail: "",
  assign: null,
  previous: null,
})

describe("buildAlertCandidates", () => {
  test("projected over budget alerts; under budget and deleted subjects don't", () => {
    const c = buildAlertCandidates(
      [status("team:t1"), status("team:t2", { state: "ok", projectedOver: false, projected: 900 }), status("team:gone", { subjectExists: false })],
      []
    )
    expect(c.map((x) => x.subject)).toEqual(["team:t1"])
    expect(c[0]).toMatchObject({ period: "2026-11", kinds: ["projected_overrun"], amount: 1500, budgetUsd: 1000 })
    expect(c[0].message).toMatch(/Projected \$1,500\.00 for 2026-11 against a \$1,000\.00 budget \(150%/)
  })

  test("an overrun and a spike for the same subject and month are one alert", () => {
    const c = buildAlertCandidates([status("person:p1")], [spike("p1", "2026-11"), spike("p2", "2026-10")])
    expect(c.map((x) => [x.subject, x.period, x.kinds])).toEqual([
      ["person:p1", "2026-11", ["projected_overrun", "spike"]],
      ["person:p2", "2026-10", ["spike"]],
    ])
    expect(c[0].message).toMatch(/Spend spike: \$2,400\.00 projected for 2026-11, 3x the \$800\.00/)
  })
})

describe("deliver", () => {
  const alert: AlertCandidate = { subject: "team:t1", period: "2026-11", kinds: ["projected_overrun"], label: "team A", amount: 1, budgetUsd: 1, message: "hi" }

  test("no send when the webhook (and email) are unset", async () => {
    const f = okFetch()
    expect(await deliver(alertConfig({ [ALERT_ENV.mode]: "live" }), alert, f)).toEqual({ sent: [], failed: [] })
    expect(f).not.toHaveBeenCalled()
  })

  test("Slack gets { text }; email goes to Resend with the key as a bearer token", async () => {
    const f = okFetch()
    const config = alertConfig({
      ...LIVE_SLACK,
      [ALERT_ENV.emailTo]: "a@x.test",
      [ALERT_ENV.emailFrom]: "alerts@x.test",
      [ALERT_ENV.resendKey]: "re_test",
    })
    expect(await deliver(config, alert, f)).toEqual({ sent: ["slack", "email"], failed: [] })
    expect(f).toHaveBeenNthCalledWith(1, HOOK, expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "hi" }) }))
    const [url, init] = f.mock.calls[1]
    expect(url).toBe(RESEND_ENDPOINT)
    expect(init.headers.Authorization).toBe("Bearer re_test")
    expect(JSON.parse(init.body)).toMatchObject({ from: "alerts@x.test", to: ["a@x.test"], text: "hi" })
  })

  test("failures are reported without the URL", async () => {
    const f = jest.fn(async () => {
      throw new TypeError(`fetch failed for ${HOOK}`)
    })
    const out = await deliver(alertConfig(LIVE_SLACK), alert, f)
    expect(out.sent).toEqual([])
    expect(JSON.stringify(out)).not.toContain(HOOK)
  })
})

// ---------------------------------------------------------------------------
// runBudgetAlerts against the in-memory Supabase fake
// ---------------------------------------------------------------------------

const AN = "prov-an"
function days(from: string, to: string, person: string, team: string, cost: number) {
  const out = []
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    out.push({ date: d, provider_id: AN, model_name: "m", person_id: person, org_api_key_id: null, team_id: team, department_id: null, project_id: null, workspace_id: null, granularity: "person", total_cost_usd: cost })
  }
  return out
}

function seed(opts: { budgets?: boolean } = {}) {
  const tables: Record<string, object[]> = {
    departments: [],
    teams: [{ id: "t1", name: "Platform", department_id: null }],
    people: [{ id: "p1", email: "p1@liatrio.com", display_name: "Pat", team_id: "t1", active: true }],
    person_identities: [],
    org_api_keys: [],
    org_projects: [],
    providers: [{ id: AN, name: "anthropic", display_name: "Anthropic", last_collected_at: "2026-11-15T06:00:00Z", documentation_url: null, metadata: null }],
    // Steady $100/day since September: Nov projects to ~$3,000, no spike.
    cost_records_daily_attributed: days("2026-09-01", "2026-11-14", "p1", "t1", 100),
    review_items: [],
    alert_log: [],
  }
  if (opts.budgets !== false) tables.budgets = [{ id: "b1", scope: "team", subject_id: "t1", monthly_usd: 2000, note: null }]
  return new FakeSupabase(tables, { ...ORG_TABLE_CONFIG, budgets: { unique: [{ columns: ["scope", "subject_id"] }] }, alert_log: { unique: [{ columns: ["subject", "period", "dry_run"] }] } })
}

/** The fake without migration 020: budgets and alert_log don't exist. */
function without020(db: FakeSupabase) {
  const missing = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.budgets' in the schema cache" } }
  const chain: Record<string, unknown> = {}
  for (const m of ["select", "insert", "update", "delete", "eq", "single", "order", "range"]) chain[m] = () => chain
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(missing).then(ok)
  return { from: (t: string) => (t === "budgets" || t === "alert_log" ? chain : db.from(t)), rpc: db.rpc.bind(db) }
}

const run = (db: unknown, env: Record<string, string>, fetchImpl: FetchLike) =>
  runBudgetAlerts(db as SupabaseClient, { now: NOW, env: env, fetchImpl })

describe("runBudgetAlerts", () => {
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => undefined))
  afterEach(() => jest.restoreAllMocks())

  test("dry-run (default): logs the alert, sends nothing, and logs it once per month", async () => {
    const db = seed()
    const f = okFetch()
    const first = await run(db, { [ALERT_ENV.slackWebhook]: HOOK }, f)
    expect(first).toMatchObject({ status: "ok", mode: "dry_run", candidates: 1, sent: 1, deduped: 0 })
    expect(first.alerts[0]).toMatchObject({ subject: "team:t1", period: "2026-11", kinds: ["projected_overrun"], result: "logged" })
    expect(f).not.toHaveBeenCalled()
    expect(db.table("alert_log")).toHaveLength(1)
    expect(db.table("alert_log")[0]).toMatchObject({ subject: "team:t1", period: "2026-11", dry_run: true, channels: [] })

    const again = await run(db, {}, f)
    expect(again).toMatchObject({ sent: 0, deduped: 1 })
    expect(db.table("alert_log")).toHaveLength(1)
  })

  test("live: sends once per subject per month; the next run is deduped", async () => {
    const db = seed()
    const f = okFetch()
    const first = await run(db, LIVE_SLACK as Record<string, string>, f)
    expect(first).toMatchObject({ mode: "live", sent: 1, deduped: 0, channels: ["slack"] })
    expect(f).toHaveBeenCalledTimes(1)
    expect(JSON.parse(f.mock.calls[0][1].body).text).toMatch(/AI spend alert: team Platform/)
    expect(db.table("alert_log").find((r) => r.dry_run === false)).toMatchObject({ subject: "team:t1", period: "2026-11", channels: ["slack"] })

    const second = await run(db, LIVE_SLACK as Record<string, string>, f)
    expect(second).toMatchObject({ sent: 0, deduped: 1 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  test("a dry-run log doesn't stop the first live alert", async () => {
    const db = seed()
    await run(db, {}, okFetch())
    const f = okFetch()
    expect(await run(db, LIVE_SLACK as Record<string, string>, f)).toMatchObject({ sent: 1, deduped: 0 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  test("live with the webhook unset: no send and nothing logged", async () => {
    const db = seed()
    const f = okFetch()
    const res = await run(db, { [ALERT_ENV.mode]: "live" }, f)
    expect(res).toMatchObject({ status: "no_channels", candidates: 1, sent: 0 })
    expect(f).not.toHaveBeenCalled()
    expect(db.table("alert_log")).toHaveLength(0)
  })

  test("when every channel fails the claim is released and the next run retries", async () => {
    const db = seed()
    const failing = jest.fn(async () => ({ ok: false, status: 500 }))
    expect(await run(db, LIVE_SLACK as Record<string, string>, failing)).toMatchObject({ sent: 0, failed: 1 })
    expect(db.table("alert_log")).toHaveLength(0)
    const f = okFetch()
    expect(await run(db, LIVE_SLACK as Record<string, string>, f)).toMatchObject({ sent: 1 })
  })

  test("under budget: no alert", async () => {
    const db = seed()
    db.table("budgets")[0].monthly_usd = 10000
    const f = okFetch()
    expect(await run(db, LIVE_SLACK as Record<string, string>, f)).toMatchObject({ candidates: 0, sent: 0 })
    expect(f).not.toHaveBeenCalled()
  })

  test("without migration 020: no alerts, no writes, no error", async () => {
    const db = seed({ budgets: false })
    const f = okFetch()
    const res = await run(without020(db), LIVE_SLACK as Record<string, string>, f)
    expect(res).toMatchObject({ status: "migration_020_not_applied", sent: 0, candidates: 0 })
    expect(f).not.toHaveBeenCalled()
    expect(db.writes).toHaveLength(0)
  })
})
