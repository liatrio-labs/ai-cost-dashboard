/**
 * @jest-environment node
 *
 * Issue #94: the MCP server end to end against fakes. Supabase auth
 * (lib/mcp/supabase-auth.ts) is mocked, and data reads go to an in-memory
 * fake of the query builder seeded with the dashboard route fixtures. No
 * network, no database, no secrets.
 */

import { NextRequest } from "next/server"
import { PROVIDERS, attributedRows, plainDailyRows } from "@/lib/org/dashboard-fixtures"
import { D, PE, T, orgData } from "@/lib/org/test-fixtures"
import type { OrgData } from "@/lib/org/types"
import { createHash } from "node:crypto"

process.env.MCP_OAUTH_SECRET = "test-only-secret-not-used-anywhere-else-0123456789"
process.env.MCP_PUBLIC_URL = "https://ai-cost.liatr.io"

jest.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }) }))
jest.mock("@/lib/forecast-settings", () => {
  const actual = jest.requireActual("@/lib/forecast-settings")
  return { ...actual, getForecastSettings: async () => actual.FORECAST_DEFAULTS, getForecastUnitOverrides: async () => ({}) }
})

// ---- fake Supabase data client ------------------------------------------

type Row = Record<string, unknown>
let tables: Record<string, Row[]> = {}
const writes: string[] = []

function cmp(a: unknown, b: unknown): number {
  const x = Date.parse(String(a))
  const y = Date.parse(String(b))
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y
  return String(a).localeCompare(String(b))
}

function fakeFrom(table: string) {
  let rows = [...(tables[table] ?? [])]
  let range: [number, number] | null = null
  const get = (r: Row, col: string) => {
    const m = /^(\w+)->>(\w+)$/.exec(col)
    return m ? (r[m[1]] as Row | null)?.[m[2]] : r[col]
  }
  const q = {
    select: () => q,
    order: () => q,
    eq: (col: string, v: unknown) => ((rows = rows.filter((r) => get(r, col) === v)), q),
    in: (col: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(get(r, col)))), q),
    is: (col: string, v: unknown) => ((rows = rows.filter((r) => (r[col] ?? null) === v)), q),
    gte: (col: string, v: unknown) => ((rows = rows.filter((r) => cmp(r[col], v) >= 0)), q),
    lt: (col: string, v: unknown) => ((rows = rows.filter((r) => cmp(r[col], v) < 0)), q),
    range: (a: number, b: number) => ((range = [a, b]), q),
    then: (resolve: (v: unknown) => void) => resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null }),
  }
  const writer = (op: string) => () => {
    writes.push(`${op}:${table}`)
    return q
  }
  return { select: () => q, insert: writer("insert"), update: writer("update"), upsert: writer("upsert"), delete: writer("delete") }
}

function seed(org: OrgData) {
  tables = {
    providers: PROVIDERS as unknown as Row[],
    cost_records_daily: plainDailyRows(),
    cost_records_daily_attributed: attributedRows(org) as unknown as Row[],
    departments: org.departments as unknown as Row[],
    teams: org.teams as unknown as Row[],
    people: org.people as unknown as Row[],
    person_identities: org.identities as unknown as Row[],
    org_api_keys: org.apiKeys as unknown as Row[],
  }
  writes.length = 0
}

// ---- mocked Supabase auth -----------------------------------------------

interface FakeUser {
  id: string
  email: string
  identities: { provider: string; identity_data: { email: string; email_verified?: boolean } }[]
}
const googleUser = (email: string, id = `u-${email}`): FakeUser => ({ id, email, identities: [{ provider: "google", identity_data: { email, email_verified: true } }] })

/** Supabase sessions by refresh token; a rotated token is gone (single use). */
const sessions = new Map<string, FakeUser>()
/** Valid Supabase access tokens. */
const accessTokens = new Map<string, FakeUser>()
let nextSignInUser: FakeUser = googleUser("alice@liatrio.com")
const revoked: string[] = []
let counter = 0

function newSession(user: FakeUser) {
  counter += 1
  const access_token = `sat-${counter}`
  const refresh_token = `srt-${counter}`
  sessions.set(refresh_token, user)
  accessTokens.set(access_token, user)
  return { access_token, refresh_token, expires_at: Math.floor(Date.now() / 1000) + 3600, user }
}

jest.mock("@/lib/mcp/supabase-auth", () => ({
  startGoogleSignIn: jest.fn(async (redirectTo: string) => ({
    url: `https://placeholder.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`,
    pkce: { "ai-cost-mcp-code-verifier": "supabase-pkce-verifier" },
  })),
  exchangeGoogleCode: jest.fn(async (code: string, pkce: Record<string, string>) => {
    if (code !== "supabase-code" || pkce["ai-cost-mcp-code-verifier"] !== "supabase-pkce-verifier") throw new Error("bad code")
    return newSession(nextSignInUser)
  }),
  refreshSupabaseSession: jest.fn(async (rt: string) => {
    const user = sessions.get(rt)
    if (!user) throw new Error("Invalid Refresh Token: Already Used")
    sessions.delete(rt)
    return newSession(user)
  }),
  getSupabaseUser: jest.fn(async (at: string) => accessTokens.get(at) ?? null),
  revokeSupabaseSession: jest.fn(async (s: { refresh_token: string }) => {
    revoked.push(s.refresh_token)
    sessions.delete(s.refresh_token)
  }),
  dataClient: jest.fn(() => ({ from: fakeFrom })),
}))

// Imported after the mocks.
import { POST as mcpPost, GET as mcpGet } from "./route"
import { GET as authorize } from "../oauth/authorize/route"
import { GET as callback } from "../oauth/callback/route"
import { POST as token } from "../oauth/token/route"
import { POST as register } from "../oauth/register/route"
import { GET as asMetadata } from "../../.well-known/oauth-authorization-server/route"
import { GET as prMetadata } from "../../.well-known/oauth-protected-resource/api/mcp/route"
import { seal } from "@/lib/mcp/oauth-crypto"
import { MCP_TOOLS } from "@/lib/mcp/tools"
import { loadBreakdown, loadDashboard } from "@/lib/dashboard-service"
import type { SupabaseLike } from "@/lib/dashboard-data"

const ORIGIN = "https://ai-cost.liatr.io"
const REDIRECT = "http://127.0.0.1:33418/callback"
const VERIFIER = "a".repeat(20) + "-verifier-" + "b".repeat(20)
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url")

const NOW = new Date("2026-11-03T12:00:00Z")
beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["setTimeout", "clearTimeout", "setImmediate", "nextTick", "queueMicrotask"] })
})
afterAll(() => jest.useRealTimers())
beforeEach(() => {
  seed(orgData())
  sessions.clear()
  accessTokens.clear()
  revoked.length = 0
  nextSignInUser = googleUser("alice@liatrio.com", "u-alice")
})

const req = (path: string, init?: RequestInit) => new NextRequest(new URL(path, ORIGIN), init as never)

async function registerClient(): Promise<string> {
  const res = await register(req("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test client", redirect_uris: [REDIRECT] }) }))
  expect(res.status).toBe(201)
  return (await res.json()).client_id
}

/** Run register -> authorize -> Google (mocked) -> callback, returning the client redirect. */
async function signIn(): Promise<{ clientId: string; redirect: URL }> {
  const clientId = await registerClient()
  const qs = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st-1", resource: `${ORIGIN}/api/mcp` })
  const a = await authorize(req(`/api/oauth/authorize?${qs}`))
  expect(a.status).toBe(302)
  expect(a.headers.get("location")).toContain("placeholder.supabase.co/auth/v1/authorize?provider=google")
  const setCookie = a.headers.get("set-cookie") ?? ""
  const cookie = setCookie.split(";")[0]
  expect(setCookie).toMatch(/HttpOnly/)
  const c = await callback(req("/api/oauth/callback?code=supabase-code", { headers: { cookie } }))
  expect(c.status).toBe(302)
  return { clientId, redirect: new URL(c.headers.get("location")!) }
}

async function exchange(clientId: string, code: string, verifier = VERIFIER) {
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT })
  return token(req("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }))
}

async function accessToken(): Promise<string> {
  const { clientId, redirect } = await signIn()
  const res = await exchange(clientId, redirect.searchParams.get("code")!)
  expect(res.status).toBe(200)
  return (await res.json()).access_token
}

const rpc = (method: string, params?: unknown, auth?: string, id: number | null = 1) =>
  mcpPost(
    req("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }),
    })
  )

async function callTool(at: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc("tools/call", { name, arguments: args }, at)
  expect(res.status).toBe(200)
  const body = await res.json()
  return body.result as { isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] }
}

describe("MCP OAuth metadata", () => {
  it("advertises the authorization server and protected resource like Pulse", async () => {
    const as = await (await asMetadata(req("/.well-known/oauth-authorization-server"))).json()
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/api/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    })
    const pr = await (await prMetadata(req("/.well-known/oauth-protected-resource/api/mcp"))).json()
    expect(pr).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN] })
  })
})

describe("MCP unauthenticated rejection", () => {
  it("rejects a call with no token with 401 and a WWW-Authenticate challenge", async () => {
    const res = await rpc("tools/list")
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="ai-cost:read"`
    )
    expect(writes).toEqual([])
  })

  it("rejects forged, expired, wrong-type and wrong-resource tokens", async () => {
    const exp = Math.floor(NOW.getTime() / 1000) + 600
    const valid = newSession(googleUser("alice@liatrio.com", "u-alice"))
    const base = { sat: valid.access_token, sub: "u-alice", email: "alice@liatrio.com", aud: `${ORIGIN}/api/mcp`, client_id: "c", scope: "ai-cost:read" }
    const bad = [
      "not-a-token",
      seal("access", { ...base, exp: exp - 1200 }), // expired
      seal("refresh", { ...base, srt: valid.refresh_token, exp }), // a refresh token used as an access token
      seal("access", { ...base, aud: "https://elsewhere.example/api/mcp", exp }), // another resource
      seal("access", { ...base, sat: "sat-revoked", exp }), // Supabase no longer accepts the session
    ]
    for (const t of bad) {
      const res = await rpc("tools/list", undefined, t)
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata=".*", scope="ai-cost:read", error="invalid_token"/)
    }
    // The same claims, unexpired, do work: the rejections above are the token's fault.
    expect((await rpc("tools/list", undefined, seal("access", { ...base, exp }))).status).toBe(200)
  })

  it("rejects GET without a token too", async () => {
    expect((await mcpGet(req("/api/mcp"))).status).toBe(401)
  })
})

describe("MCP liatrio-only auth", () => {
  it("signs in a Google @liatrio.com account and issues working tokens", async () => {
    const { clientId, redirect } = await signIn()
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT)
    expect(redirect.searchParams.get("state")).toBe("st-1")
    const code = redirect.searchParams.get("code")!
    expect(code).toBeTruthy()

    const res = await exchange(clientId, code)
    expect(res.status).toBe(200)
    const tokens = await res.json()
    expect(tokens).toMatchObject({ token_type: "Bearer", scope: "ai-cost:read" })
    // Our token wraps the Supabase session; it is not the raw Supabase token.
    expect(tokens.access_token).not.toMatch(/^sat-/)

    // The code is single-use: redeeming it again fails.
    expect((await exchange(clientId, code)).status).toBe(400)

    // Refresh rotates.
    const refresh = (body: Record<string, string>) =>
      token(req("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() }))
    const r1 = await refresh({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token })
    expect(r1.status).toBe(200)
    expect((await refresh({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token })).status).toBe(400)

    expect((await rpc("tools/list", undefined, (await r1.json()).access_token)).status).toBe(200)
  })

  it.each([
    ["a gmail account", googleUser("someone@gmail.com")],
    ["a look-alike domain", googleUser("robert@liatrio.com.evil.example")],
    ["a liatrio subdomain", googleUser("robert@eng.liatrio.com")],
    ["a non-Google identity with a liatrio email", { id: "u-pw", email: "robert@liatrio.com", identities: [{ provider: "email", identity_data: { email: "robert@liatrio.com" } }] }],
    ["a Google identity whose email differs", { id: "u-mix", email: "robert@liatrio.com", identities: [{ provider: "google", identity_data: { email: "robert@gmail.com" } }] }],
  ])("refuses %s at the callback and revokes the session", async (_label, user) => {
    nextSignInUser = user as FakeUser
    const { redirect } = await signIn()
    expect(redirect.searchParams.get("error")).toBe("access_denied")
    expect(redirect.searchParams.get("error_description")).toMatch(/@liatrio\.com/)
    expect(redirect.searchParams.get("code")).toBeNull()
    expect(redirect.searchParams.get("state")).toBe("st-1")
    expect(revoked).toHaveLength(1)
  })

  it("refuses a bearer token whose Supabase user is not a liatrio Google account", async () => {
    const s = newSession(googleUser("someone@gmail.com", "u-g"))
    const t = seal("access", { sat: s.access_token, sub: "u-g", email: "someone@gmail.com", aud: `${ORIGIN}/api/mcp`, client_id: "c", scope: "ai-cost:read", exp: Math.floor(NOW.getTime() / 1000) + 600 })
    expect((await rpc("tools/list", undefined, t)).status).toBe(401)
  })

  it("requires PKCE S256 and a matching verifier", async () => {
    const { clientId, redirect } = await signIn()
    const res = await exchange(clientId, redirect.searchParams.get("code")!, "x".repeat(50))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_grant")

    const qs = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s" })
    const a = await authorize(req(`/api/oauth/authorize?${qs}`))
    expect(new URL(a.headers.get("location")!).searchParams.get("error")).toBe("invalid_request")
  })

  it("never redirects to an unregistered redirect_uri", async () => {
    const clientId = await registerClient()
    const qs = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://attacker.example/cb", code_challenge: CHALLENGE, code_challenge_method: "S256" })
    const a = await authorize(req(`/api/oauth/authorize?${qs}`))
    expect(a.status).toBe(400)
    expect(a.headers.get("location")).toBeNull()
    const bad = await register(req("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) }))
    expect(bad.status).toBe(400)
  })
})

describe("MCP tools are read-only", () => {
  const EXPECTED = [
    "get_monthly_headline",
    "get_spend_by_tool",
    "get_spend_by_person",
    "get_person_spend",
    "get_spend_by_department",
    "get_spend_by_team",
    "get_api_key_spend",
    "get_cursor_billing_cycle",
    "get_seat_assignments",
    "list_org_directory",
  ]

  it("lists exactly the read tools and no write / admin / collection / secret tools", async () => {
    const at = await accessToken()
    const init = await (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, at)).json()
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "ai-cost-dashboard" }, capabilities: { tools: {} } })
    expect((await rpc("notifications/initialized", undefined, at, null)).status).toBe(202)

    const { result } = await (await rpc("tools/list", undefined, at)).json()
    const names: string[] = result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(EXPECTED)
    for (const t of result.tools) {
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
      expect(`${t.name} ${t.title}`).not.toMatch(/collect|backfill|sync|assign_|set_|update|delete|create|insert|write|override|invoice|admin|secret|token|key_dump|refresh|trigger/i)
    }
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(EXPECTED)
  })

  it("answers unknown tools with an error and writes nothing across every tool", async () => {
    const at = await accessToken()
    const unknown = await (await rpc("tools/call", { name: "collect_now", arguments: {} }, at)).json()
    expect(unknown.error.code).toBe(-32602)
    for (const name of EXPECTED) await callTool(at, name, name === "get_person_spend" ? { month: "2026-11" } : {})
    expect(writes).toEqual([])
  })
})

describe("MCP reads match the dashboard", () => {
  const fake = { from: fakeFrom } as unknown as SupabaseLike

  it("org headline equals /api/dashboard's KPIs", async () => {
    const at = await accessToken()
    const r = await callTool(at, "get_monthly_headline", { month: "2026-11" })
    expect(r.isError).toBeUndefined()
    const d = await loadDashboard(fake, new URLSearchParams({ month: "2026-11" }), NOW)
    expect(r.structuredContent).toMatchObject({
      totalSpend: 250,
      fixedSubscriptionSpend: 0,
      variableUsageSpend: 250,
      previousPeriodSpend: d.kpis.prevSpend,
      changePercent: d.kpis.changePercent,
    })
    expect(r.structuredContent.totalSpend).toBe(d.kpis.totalSpend)
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent)
  })

  it("department and team spend equal /api/dashboard/breakdown's rows", async () => {
    const at = await accessToken()
    const b = await loadBreakdown(fake, new URLSearchParams({ month: "2026-11" }), NOW)
    const dept = (await callTool(at, "get_spend_by_department", { month: "2026-11" })).structuredContent as { departments: { id: string; spend: number }[]; total: number }
    expect(dept.total).toBe(b.total.cost)
    expect(dept.departments.map((x) => [x.id, x.spend])).toEqual(b.department.map((x) => [x.id, Math.round(x.cost * 100) / 100]))
    expect(dept.departments.find((x) => x.id === D.eng)!.spend).toBeGreaterThan(0)

    const teams = (await callTool(at, "get_spend_by_team", { month: "2026-11", department: "Engineering" })).structuredContent as { teams: { id: string }[]; filters: Record<string, string> }
    expect(teams.filters).toEqual({ department: D.eng })
    const bt = await loadBreakdown(fake, new URLSearchParams({ month: "2026-11", department: D.eng }), NOW)
    expect(teams.teams.map((x) => x.id)).toEqual(bt.team.map((x) => x.id))
    expect(teams.teams.map((x) => x.id)).toContain(T.platform)
  })

  it("person spend: by person, by email, and the caller by default", async () => {
    const at = await accessToken()
    const people = (await callTool(at, "get_spend_by_person", { month: "2026-11" })).structuredContent as { people: { id: string; spend: number }[] }
    const b = await loadBreakdown(fake, new URLSearchParams({ month: "2026-11" }), NOW)
    expect(people.people.map((p) => p.id)).toEqual(b.person.map((p) => p.id))

    const bp = await loadBreakdown(fake, new URLSearchParams({ month: "2026-11", person: PE.alice }), NOW)
    const byEmail = (await callTool(at, "get_person_spend", { month: "2026-11", person: "alice@liatrio.com" })).structuredContent
    expect(byEmail).toMatchObject({ person: { id: PE.alice, name: "Alice" }, totalSpend: bp.total.cost })
    // The signed-in caller is Alice, so no person argument means Alice.
    const mine = (await callTool(at, "get_person_spend", { month: "2026-11" })).structuredContent
    expect(mine).toEqual(byEmail)
  })

  it("rejects bad input without loading data", async () => {
    const at = await accessToken()
    expect((await callTool(at, "get_monthly_headline", { month: "Nov" })).isError).toBe(true)
    expect((await callTool(at, "get_spend_by_team", { department: "Nope" })).isError).toBe(true)
    expect((await callTool(at, "get_spend_by_team", { surprise: 1 })).isError).toBe(true)
  })

  it("keeps Cursor billing-cycle on-demand separate (unavailable without migration 025)", async () => {
    const at = await accessToken()
    const r = (await callTool(at, "get_cursor_billing_cycle")).structuredContent
    // The fake has no cursor_spend_cycles table, which reads as empty: a separate measure, no totals mixed in.
    expect(r).not.toHaveProperty("totalSpend")
    expect(JSON.stringify(r)).not.toMatch(/calendar.*\+|seatsSubscription/)
  })
})

describe("MCP Cursor cost rules", () => {
  const RATES = [
    { seat_type: "standard", effective_month: "2000-01-01", monthly_rate_usd: "40.00" },
    { seat_type: "premium", effective_month: "2000-01-01", monthly_rate_usd: "80.00" },
    { seat_type: "free", effective_month: "2000-01-01", monthly_rate_usd: "0.00" },
  ]
  const seat = (person_id: string, seat_type: string) => ({ person_id, effective_month: "2026-11-01", seat_type, source: "admin" })
  const NOV19 = "2026-11-19T00:00:00.000Z"

  beforeEach(() => {
    tables.cursor_seat_rates = RATES
    tables.cursor_seat_assignments = [seat(PE.dave, "premium"), seat(PE.alice, "standard")]
    // Cursor included-in-business usage: stored at $0 by the collector.
    tables.cost_records_daily.push({ date: "2026-11-02", provider_id: "prov-cursor", model_name: "claude-4-sonnet", total_cost_usd: 0, total_tokens: 5000, total_requests: 40 })
    tables.cursor_spend_cycles = [{ cycle_start: NOV19, team_spend_cents: "1234.0000", team_overall_spend_cents: "99999.0000", member_count: 1, first_captured_at: NOV19, captured_at: "2026-11-20T00:05:00Z" }]
    tables.cursor_member_cycle_spend = [
      { cycle_start: NOV19, member_email: "dave@liatrio.com", member_name: null, cursor_user_id: null, role: "member", spend_cents: "1234.0000", overall_spend_cents: "99999.0000", monthly_limit_dollars: "100.00", hard_limit_override_dollars: null, effective_per_user_limit_dollars: "100.00", captured_at: NOV19 },
    ]
  })

  it("seats are fixed, included usage adds nothing, and cycle on-demand is not in calendar totals", async () => {
    const at = await accessToken()
    const head = (await callTool(at, "get_monthly_headline", { month: "2026-11" })).structuredContent
    // $250 metered usage + $120 seats (Dave premium $80, Alice standard $40); the $0 included row and $12.34 cycle add nothing.
    expect(head).toMatchObject({ totalSpend: 370, fixedSubscriptionSpend: 120, variableUsageSpend: 250 })

    const tools = (await callTool(at, "get_spend_by_tool", { month: "2026-11" })).structuredContent as { tools: { id: string; spend: number; products?: { product: string; spend: number }[]; cursorCostTypes?: Record<string, number> }[] }
    const cursor = tools.tools.find((t) => t.id === "prov-cursor")!
    expect(cursor.spend).toBe(150)
    expect(Object.fromEntries(cursor.products!.map((p) => [p.product, p.spend]))).toEqual({ grok_bot: 0, bugbot: 0, agent_chat: 30, seats: 120 })
    expect(cursor.cursorCostTypes).toMatchObject({ seatsSubscription: 120, calendarMonthOnDemand: 30 })

    const cycle = (await callTool(at, "get_cursor_billing_cycle")).structuredContent as { current: { teamOnDemandSpend: number } }
    expect(cycle.current.teamOnDemandSpend).toBe(12.34)
    // Reading the cycle changes nothing in the calendar view.
    expect((await callTool(at, "get_monthly_headline", { month: "2026-11" })).structuredContent.totalSpend).toBe(370)
  })

  it("seat assignments are readable context", async () => {
    const at = await accessToken()
    const r = (await callTool(at, "get_seat_assignments", { month: "2026-11" })).structuredContent as { cursor: { seats: { personId: string; seatType: string; cycleRate: number }[] } }
    expect(r.cursor.seats.map((s) => [s.personId, s.seatType, s.cycleRate])).toEqual([
      [PE.alice, "standard", 40],
      [PE.dave, "premium", 80],
    ])
    expect(writes).toEqual([])
  })
})
