/**
 * @jest-environment node
 *
 * Route handler tests for /api/admin/org/*. The real requireAdmin runs
 * against a mocked Supabase auth client; the service-role client is an
 * in-memory fake (testing/fake-supabase.ts). No network, no database.
 */

import { NextRequest } from "next/server"
import type { FakeSupabase } from "./testing/fake-supabase"
import { MONTH, seedDb } from "./testing/seed"
import { D, K, P, PE, PR, T } from "../test-fixtures"

const mockAuth = { user: null as null | { id: string; email: string } }
const mockState = { db: null as unknown as FakeSupabase, refreshes: 0 }

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
  refreshDailyAggregates: async () => {
    mockState.refreshes += 1
  },
}))

import * as orgRoot from "@/app/api/admin/org/route"
import * as departments from "@/app/api/admin/org/departments/route"
import * as department from "@/app/api/admin/org/departments/[id]/route"
import * as teams from "@/app/api/admin/org/teams/route"
import * as team from "@/app/api/admin/org/teams/[id]/route"
import * as people from "@/app/api/admin/org/people/route"
import * as person from "@/app/api/admin/org/people/[id]/route"
import * as peopleImport from "@/app/api/admin/org/people/import/route"
import * as identities from "@/app/api/admin/org/identities/route"
import * as identity from "@/app/api/admin/org/identities/[id]/route"
import * as keys from "@/app/api/admin/org/keys/route"
import * as key from "@/app/api/admin/org/keys/[id]/route"
import * as projects from "@/app/api/admin/org/projects/route"
import * as projectRoute from "@/app/api/admin/org/projects/[id]/route"
import * as unassigned from "@/app/api/admin/org/unassigned/route"
import * as assign from "@/app/api/admin/org/unassigned/assign/route"
import * as syncGateway from "@/app/api/admin/org/keys/sync-gateway/route"
import * as syncKeys from "@/app/api/admin/org/keys/sync/route"
import * as assignCreator from "@/app/api/admin/org/keys/assign-creator/route"

const ADMIN = { id: "u-admin", email: "admin@example.com" }
const OUTSIDER = { id: "u-out", email: "someone@elsewhere.test" }

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

async function call(handler: unknown, method: string, path: string, body?: unknown, params: Record<string, string> = {}) {
  const req = new NextRequest(new URL(path, "http://localhost"), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  })
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) })
  return { status: res.status, body: await res.json() }
}

const rows = (table: string) => mockState.db.table(table)
const writesTo = (table: string) => mockState.db.writes.filter((w) => w.table === table)

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
  process.env.ADMIN_DOMAINS = "admins.example.test"
})
afterAll(() => {
  process.env = savedEnv
})
beforeEach(() => {
  mockState.db = seedDb()
  mockState.refreshes = 0
  mockAuth.user = ADMIN
})

// ---------------------------------------------------------------------------
// Auth: 401 unauthenticated, 403 non-admin, on every handler
// ---------------------------------------------------------------------------

// Every row has 5 entries: jest treats a test fn with more params than row
// entries as callback-style (done), so params is always given.
const EVERY_HANDLER: [string, unknown, string, string, Record<string, string>][] = [
  ["GET org", orgRoot.GET, "GET", "/api/admin/org", {}],
  ["GET departments", departments.GET, "GET", "/api/admin/org/departments", {}],
  ["POST departments", departments.POST, "POST", "/api/admin/org/departments", {}],
  ["PATCH department", department.PATCH, "PATCH", "/api/admin/org/departments/x", { id: D.eng }],
  ["DELETE department", department.DELETE, "DELETE", "/api/admin/org/departments/x", { id: D.eng }],
  ["GET teams", teams.GET, "GET", "/api/admin/org/teams", {}],
  ["POST teams", teams.POST, "POST", "/api/admin/org/teams", {}],
  ["PATCH team", team.PATCH, "PATCH", "/api/admin/org/teams/x", { id: T.data }],
  ["DELETE team", team.DELETE, "DELETE", "/api/admin/org/teams/x", { id: T.data }],
  ["GET people", people.GET, "GET", "/api/admin/org/people", {}],
  ["POST people", people.POST, "POST", "/api/admin/org/people", {}],
  ["PATCH person", person.PATCH, "PATCH", "/api/admin/org/people/x", { id: PE.alice }],
  ["POST import", peopleImport.POST, "POST", "/api/admin/org/people/import", {}],
  ["POST identities", identities.POST, "POST", "/api/admin/org/identities", {}],
  ["DELETE identity", identity.DELETE, "DELETE", "/api/admin/org/identities/x", { id: "ident-1" }],
  ["GET keys", keys.GET, "GET", "/api/admin/org/keys", {}],
  ["POST keys", keys.POST, "POST", "/api/admin/org/keys", {}],
  ["DELETE key", key.DELETE, "DELETE", "/api/admin/org/keys/x", { id: K.bare }],
  ["GET projects", projects.GET, "GET", "/api/admin/org/projects", {}],
  ["POST projects", projects.POST, "POST", "/api/admin/org/projects", {}],
  ["DELETE project", projectRoute.DELETE, "DELETE", "/api/admin/org/projects/x", { id: PR.sales }],
  ["GET unassigned", unassigned.GET, "GET", "/api/admin/org/unassigned", {}],
  ["POST assign", assign.POST, "POST", "/api/admin/org/unassigned/assign", {}],
  ["POST sync-gateway", syncGateway.POST, "POST", "/api/admin/org/keys/sync-gateway", {}],
  ["POST keys/sync", syncKeys.POST, "POST", "/api/admin/org/keys/sync", {}],
  ["POST keys/assign-creator", assignCreator.POST, "POST", "/api/admin/org/keys/assign-creator", {}],
]

describe("auth", () => {
  it.each(EVERY_HANDLER)("%s: 401 when unauthenticated", async (_n, handler, method, path, params) => {
    mockAuth.user = null
    const res = await call(handler, method, path, method === "GET" || method === "DELETE" ? undefined : {}, params)
    expect(res).toEqual({ status: 401, body: { error: "Unauthorized" } })
  })

  it.each(EVERY_HANDLER)("%s: 403 for a signed-in non-admin", async (_n, handler, method, path, params) => {
    mockAuth.user = OUTSIDER
    const res = await call(handler, method, path, method === "GET" || method === "DELETE" ? undefined : {}, params)
    expect(res).toEqual({ status: 403, body: { error: "Forbidden" } })
  })

  it("rejected requests write nothing", async () => {
    mockAuth.user = OUTSIDER
    await call(departments.POST, "POST", "/api/admin/org/departments", { name: "Ops" })
    await call(team.DELETE, "DELETE", "/api/admin/org/teams/x?confirm=true", undefined, { id: T.data })
    expect(mockState.db.writes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

describe("departments", () => {
  it("creates, lists, renames", async () => {
    const created = await call(departments.POST, "POST", "/api/admin/org/departments", { name: "  Operations " })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ name: "Operations", description: null })

    const list = await call(departments.GET, "GET", "/api/admin/org/departments")
    expect(list.body.map((d: { name: string }) => d.name)).toEqual(["Engineering", "Operations", "Sales"])

    const renamed = await call(department.PATCH, "PATCH", "/x", { name: "Ops" }, { id: created.body.id })
    expect(renamed).toMatchObject({ status: 200, body: { id: created.body.id, name: "Ops" } })
  })

  it("rejects a duplicate name (case-insensitive) and an empty patch", async () => {
    const dup = await call(departments.POST, "POST", "/x", { name: "engineering" })
    expect(dup.status).toBe(400)
    expect(dup.body.error).toMatch(/already exists/)

    const empty = await call(department.PATCH, "PATCH", "/x", {}, { id: D.eng })
    expect(empty).toMatchObject({ status: 400, body: { error: "Nothing to update" } })
  })

  it("404s an unknown department", async () => {
    const res = await call(department.PATCH, "PATCH", "/x", { name: "X" }, { id: "nope" })
    expect(res).toEqual({ status: 404, body: { error: "Department not found" } })
  })

  it("deletes an empty department", async () => {
    const created = await call(departments.POST, "POST", "/x", { name: "Temp" })
    const res = await call(department.DELETE, "DELETE", "/x", undefined, { id: created.body.id })
    expect(res).toEqual({ status: 200, body: { deleted: created.body.id, reassigned: { teams: 0 } } })
    expect(rows("departments").some((d) => d.id === created.body.id)).toBe(false)
  })

  it("blocks deleting a department with teams unless confirmed, then moves them to no department", async () => {
    const blocked = await call(department.DELETE, "DELETE", "/x", undefined, { id: D.eng })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toMatch(/still has 2 team/)
    expect(blocked.body.blockers.teams.map((t: { id: string }) => t.id).sort()).toEqual([T.data, T.platform].sort())
    expect(mockState.db.writes).toEqual([])

    const ok = await call(department.DELETE, "DELETE", "/x?confirm=true", undefined, { id: D.eng })
    expect(ok).toEqual({ status: 200, body: { deleted: D.eng, reassigned: { teams: 2 } } })
    expect(rows("departments").some((d) => d.id === D.eng)).toBe(false)
    expect(rows("teams").filter((t) => [T.data, T.platform].includes(t.id as string)).every((t) => t.department_id === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

describe("teams", () => {
  it("creates a team in a department; the same name is fine in another department", async () => {
    const a = await call(teams.POST, "POST", "/x", { name: "Growth", department_id: D.eng })
    expect(a).toMatchObject({ status: 201, body: { name: "Growth", department_id: D.eng } })
    const b = await call(teams.POST, "POST", "/x", { name: "Growth", department_id: D.sales })
    expect(b.status).toBe(201)
    const c = await call(teams.POST, "POST", "/x", { name: "Growth" })
    expect(c).toMatchObject({ status: 201, body: { department_id: null } })
  })

  it("rejects a duplicate team name in the same department, and an unknown department", async () => {
    const dup = await call(teams.POST, "POST", "/x", { name: "platform", department_id: D.eng })
    expect(dup).toMatchObject({ status: 400, body: { error: 'A team named "platform" already exists in Engineering' } })
    const orphanDup = await call(teams.POST, "POST", "/x", { name: "Orphan", department_id: null })
    expect(orphanDup.status).toBe(400)
    const unknown = await call(teams.POST, "POST", "/x", { name: "X", department_id: "dept-missing" })
    expect(unknown).toMatchObject({ status: 400, body: { error: "Unknown department id: dept-missing" } })
    expect(writesTo("teams")).toEqual([])
  })

  it("renames and moves a team between departments, refreshing the rollup on a move", async () => {
    const renamed = await call(team.PATCH, "PATCH", "/x", { name: "Data Eng" }, { id: T.data })
    expect(renamed).toMatchObject({ status: 200, body: { name: "Data Eng", department_id: D.eng } })
    expect(mockState.refreshes).toBe(0)

    const moved = await call(team.PATCH, "PATCH", "/x", { department_id: D.sales }, { id: T.data })
    expect(moved).toMatchObject({ status: 200, body: { department_id: D.sales } })
    expect(mockState.refreshes).toBe(1)
  })

  it("rejects a move that would collide with a team of the same name", async () => {
    await call(teams.POST, "POST", "/x", { name: "Platform", department_id: D.sales })
    const res = await call(team.PATCH, "PATCH", "/x", { department_id: D.sales }, { id: T.platform })
    expect(res).toMatchObject({ status: 400, body: { error: 'A team named "Platform" already exists in Sales' } })
  })

  it("deletes an empty team", async () => {
    const created = await call(teams.POST, "POST", "/x", { name: "Empty" })
    const res = await call(team.DELETE, "DELETE", "/x", undefined, { id: created.body.id })
    expect(res.status).toBe(200)
    expect(rows("teams").some((t) => t.id === created.body.id)).toBe(false)
  })

  it("blocks deleting a non-empty team unless confirmed", async () => {
    // Data has dave (person) and key_team (API key).
    const blocked = await call(team.DELETE, "DELETE", "/x", undefined, { id: T.data })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toMatch(/still has 1 person\(s\), 1 API key\(s\) and 0 project\(s\)/)
    expect(blocked.body.blockers).toEqual({
      people: [{ id: PE.dave, email: "dave@liatrio.com" }],
      api_keys: [{ id: K.team, external_key_id: "key_team" }],
      projects: [],
    })
    expect(mockState.db.writes).toEqual([])
    expect(rows("teams").some((t) => t.id === T.data)).toBe(true)

    const notConfirmed = await call(team.DELETE, "DELETE", "/x?confirm=false", undefined, { id: T.data })
    expect(notConfirmed.status).toBe(409)

    const ok = await call(team.DELETE, "DELETE", "/x?confirm=true", undefined, { id: T.data })
    expect(ok).toEqual({
      status: 200,
      body: { deleted: T.data, reassigned: { people: 1, api_keys: 1, projects: 0 } },
    })
    expect(rows("teams").some((t) => t.id === T.data)).toBe(false)
    expect(rows("people").find((p) => p.id === PE.dave)?.team_id).toBeNull()
    expect(rows("org_api_keys").find((k) => k.id === K.team)?.team_id).toBeNull()
    expect(mockState.refreshes).toBe(1)
  })

  it("a team with only a project is non-empty too", async () => {
    const res = await call(team.DELETE, "DELETE", "/x", undefined, { id: T.field })
    expect(res.status).toBe(409)
    expect(res.body.blockers.projects).toEqual([{ id: PR.sales, external_project_id: "proj_2" }])
  })
})

// ---------------------------------------------------------------------------
// People and identities
// ---------------------------------------------------------------------------

describe("people", () => {
  it("lists people with their identities", async () => {
    const res = await call(people.GET, "GET", "/x")
    expect(res.status).toBe(200)
    const bob = res.body.find((p: { id: string }) => p.id === PE.bob)
    expect(bob.identities).toEqual([expect.objectContaining({ provider_id: P.anthropic, external_id: "user_bob" })])
  })

  it("adds a person with a lower-cased email and a team", async () => {
    const res = await call(people.POST, "POST", "/x", { email: " Frank@Liatrio.com ", display_name: "Frank", team_id: T.platform })
    expect(res).toMatchObject({
      status: 201,
      body: { email: "frank@liatrio.com", display_name: "Frank", team_id: T.platform, active: true },
    })
    expect(mockState.refreshes).toBe(1)
  })

  it("rejects an invalid email, an unknown team id and a duplicate email", async () => {
    const bad = await call(people.POST, "POST", "/x", { email: "not-an-email" })
    expect(bad).toMatchObject({ status: 400, body: { error: "Invalid email address" } })
    const team404 = await call(people.POST, "POST", "/x", { email: "x@liatrio.com", team_id: "team-missing" })
    expect(team404).toMatchObject({ status: 400, body: { error: "Unknown team id: team-missing" } })
    const dup = await call(people.POST, "POST", "/x", { email: "ALICE@liatrio.com" })
    expect(dup).toMatchObject({ status: 400, body: { error: "A person with email alice@liatrio.com already exists" } })
    expect(writesTo("people")).toEqual([])
  })

  it("edits, assigns to a team, unassigns and deactivates", async () => {
    const edit = await call(person.PATCH, "PATCH", "/x", { display_name: "Carol C" }, { id: PE.carol })
    expect(edit).toMatchObject({ status: 200, body: { display_name: "Carol C" } })
    expect(mockState.refreshes).toBe(0)

    const assigned = await call(person.PATCH, "PATCH", "/x", { team_id: T.field }, { id: PE.carol })
    expect(assigned).toMatchObject({ status: 200, body: { team_id: T.field } })
    expect(mockState.refreshes).toBe(1)

    const unassignedP = await call(person.PATCH, "PATCH", "/x", { team_id: null }, { id: PE.carol })
    expect(unassignedP).toMatchObject({ status: 200, body: { team_id: null } })

    const off = await call(person.PATCH, "PATCH", "/x", { active: false }, { id: PE.carol })
    expect(off).toMatchObject({ status: 200, body: { active: false } })
    expect(rows("people").some((p) => p.id === PE.carol)).toBe(true)
  })

  it("rejects unknown fields and 404s an unknown person", async () => {
    const extra = await call(person.PATCH, "PATCH", "/x", { team: T.field }, { id: PE.carol })
    expect(extra.status).toBe(400)
    const missing = await call(person.PATCH, "PATCH", "/x", { active: false }, { id: "p-missing" })
    expect(missing).toEqual({ status: 404, body: { error: "Person not found" } })
  })

  it("rejects a body that is not JSON", async () => {
    const req = new NextRequest(new URL("/x", "http://localhost"), { method: "POST", body: "{nope" })
    const res = await (people.POST as unknown as Handler)(req, { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Body must be valid JSON" })
  })
})

describe("identities", () => {
  it("adds and removes an identity mapping", async () => {
    const created = await call(identities.POST, "POST", "/x", {
      person_id: PE.carol,
      provider_id: P.openai,
      external_id: "user_carol",
    })
    expect(created).toMatchObject({ status: 201, body: { person_id: PE.carol, provider_id: P.openai, external_id: "user_carol" } })

    const removed = await call(identity.DELETE, "DELETE", "/x", undefined, { id: created.body.id })
    expect(removed).toEqual({ status: 200, body: { deleted: created.body.id } })
    expect(rows("person_identities").some((i) => i.id === created.body.id)).toBe(false)
  })

  it("lower-cases email-shaped ids, and rejects duplicates, unknown people and providers", async () => {
    const email = await call(identities.POST, "POST", "/x", { person_id: PE.carol, provider_id: P.cursor, external_id: "Carol.Alias@Liatrio.com" })
    expect(email.body.external_id).toBe("carol.alias@liatrio.com")

    const dup = await call(identities.POST, "POST", "/x", { person_id: PE.carol, provider_id: P.anthropic, external_id: "user_bob" })
    expect(dup).toMatchObject({ status: 400, body: { error: "Identity user_bob is already mapped for this provider" } })
    const badPerson = await call(identities.POST, "POST", "/x", { person_id: "p-missing", provider_id: P.anthropic, external_id: "u1" })
    expect(badPerson).toMatchObject({ status: 400, body: { error: "Unknown person id: p-missing" } })
    const badProvider = await call(identities.POST, "POST", "/x", { person_id: PE.carol, provider_id: "prov-x", external_id: "u1" })
    expect(badProvider).toMatchObject({ status: 400, body: { error: "Unknown provider id: prov-x" } })
  })
})

// ---------------------------------------------------------------------------
// API keys and projects
// ---------------------------------------------------------------------------

describe("keys", () => {
  it("lists every observed key plus registered keys", async () => {
    const res = await call(keys.GET, "GET", "/x")
    expect(res.status).toBe(200)
    const byId = Object.fromEntries(res.body.map((k: { external_key_id: string }) => [k.external_key_id, k]))
    expect(Object.keys(byId).sort()).toEqual(["key_bare", "key_owner", "key_team", "key_unknown"])
    expect(byId.key_unknown).toMatchObject({ id: null, provider_id: P.openai, name: "CI key", observed: true, total_cost_usd: 2 })
    expect(byId.key_team).toMatchObject({ id: K.team, team_id: T.data, observed: true, total_cost_usd: 20 })
    expect(byId.key_owner).toMatchObject({ id: K.owner, observed: false, total_cost_usd: 0 })
  })

  it("registers an observed key with an owner and team, then reassigns it", async () => {
    const created = await call(keys.POST, "POST", "/x", {
      provider_id: P.openai,
      external_key_id: "key_unknown",
      name: "CI key",
      owner_person_id: PE.carol,
      team_id: T.platform,
    })
    expect(created).toMatchObject({
      status: 201,
      body: { external_key_id: "key_unknown", owner_person_id: PE.carol, team_id: T.platform },
    })

    const updated = await call(keys.POST, "POST", "/x", { provider_id: P.openai, external_key_id: "key_unknown", team_id: null })
    expect(updated).toMatchObject({ status: 200, body: { id: created.body.id, owner_person_id: PE.carol, team_id: null } })
    expect(rows("org_api_keys").filter((k) => k.external_key_id === "key_unknown")).toHaveLength(1)
    expect(mockState.refreshes).toBe(2)
  })

  it("assigns an owner to an existing key without touching its team", async () => {
    const res = await call(keys.POST, "POST", "/x", { provider_id: P.openai, external_key_id: "key_team", owner_person_id: PE.dave })
    expect(res).toMatchObject({ status: 200, body: { id: K.team, owner_person_id: PE.dave, team_id: T.data } })
  })

  it("rejects unknown owner, team and provider ids", async () => {
    const res = await call(keys.POST, "POST", "/x", {
      provider_id: "prov-x",
      external_key_id: "k",
      owner_person_id: "p-x",
      team_id: "t-x",
    })
    expect(res.status).toBe(400)
    expect(res.body.issues.map((i: { message: string }) => i.message).sort()).toEqual(
      ["Unknown person id: p-x", "Unknown provider id: prov-x", "Unknown team id: t-x"].sort()
    )
  })

  it("unregisters a key", async () => {
    const res = await call(key.DELETE, "DELETE", "/x", undefined, { id: K.bare })
    expect(res).toEqual({ status: 200, body: { deleted: K.bare } })
    const missing = await call(key.DELETE, "DELETE", "/x", undefined, { id: K.bare })
    expect(missing.status).toBe(404)
  })
})

describe("projects", () => {
  it("lists observed and registered projects, assigns and unregisters", async () => {
    const list = await call(projects.GET, "GET", "/x")
    const ids = list.body.map((p: { external_project_id: string }) => p.external_project_id).sort()
    // Anthropic workspaces are listed too (issue #28).
    expect(ids).toEqual(["proj_1", "proj_2", "proj_9", "wrk_1"])
    expect(list.body.find((p: { external_project_id: string }) => p.external_project_id === "wrk_1")).toMatchObject({ kind: "workspace" })
    expect(list.body.find((p: { external_project_id: string }) => p.external_project_id === "proj_1")).toMatchObject({ kind: "project" })

    const created = await call(projects.POST, "POST", "/x", { provider_id: P.openai, external_project_id: "proj_9", team_id: T.data })
    expect(created).toMatchObject({ status: 201, body: { external_project_id: "proj_9", team_id: T.data } })

    const removed = await call(projectRoute.DELETE, "DELETE", "/x", undefined, { id: created.body.id })
    expect(removed.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Import from observed data
// ---------------------------------------------------------------------------

describe("people import", () => {
  it("dry run lists the distinct new emails and creates nothing", async () => {
    const res = await call(peopleImport.POST, "POST", "/x", {})
    expect(res.status).toBe(200)
    expect(res.body.dry_run).toBe(true)
    expect(res.body.candidates).toEqual([
      { email: "new.person@liatrio.com", display_name: "New Person", provider_ids: [P.anthropic, P.cursor].sort(), total_cost_usd: 15, record_count: 2 },
      { email: "zed@liatrio.com", display_name: null, provider_ids: [P.anthropic], total_cost_usd: 2, record_count: 1 },
    ])
    expect(res.body.would_create).toBe(2)
    // alice/carol are people; dave.alias is an identity; bobby@ resolves via user_bob.
    expect(res.body.already_known).toEqual(["alice@liatrio.com", "bobby@other.com", "carol@liatrio.com", "dave.alias@liatrio.com"])
    expect(mockState.db.writes).toEqual([])
    expect(mockState.refreshes).toBe(0)

    const explicit = await call(peopleImport.POST, "POST", "/x", { confirm: false })
    expect(explicit.body.dry_run).toBe(true)
    expect(mockState.db.writes).toEqual([])
  })

  it("creates the people only once confirmed", async () => {
    const before = rows("people").length
    const res = await call(peopleImport.POST, "POST", "/x", { confirm: true, team_id: T.orphan })
    expect(res.status).toBe(201)
    expect(res.body.created.map((p: { email: string }) => p.email)).toEqual(["new.person@liatrio.com", "zed@liatrio.com"])
    expect(res.body.created.every((p: { team_id: string }) => p.team_id === T.orphan)).toBe(true)
    expect(rows("people")).toHaveLength(before + 2)
    expect(mockState.refreshes).toBe(1)

    const again = await call(peopleImport.POST, "POST", "/x", {})
    expect(again.body.candidates).toEqual([])
  })

  it("a confirmed import can be limited to chosen emails", async () => {
    const res = await call(peopleImport.POST, "POST", "/x", { confirm: true, emails: ["ZED@liatrio.com", "alice@liatrio.com"] })
    expect(res.body.created.map((p: { email: string }) => p.email)).toEqual(["zed@liatrio.com"])
    expect(res.body.skipped).toEqual(["alice@liatrio.com"])
  })

  it("never imports an email that already resolves through an identity on another provider", async () => {
    // dave.alias@ is dave's cursor identity; an unmatched anthropic row must not
    // make it importable (a people row would take over dave's cursor spend).
    rows("cost_records").push({
      id: "cr-conflict",
      provider_id: P.anthropic,
      timestamp: "2026-10-25T12:00:00.000Z",
      cost_usd: 3,
      metadata: { attribution: { person_email: "dave.alias@liatrio.com", granularity: "person" } },
    })
    const preview = await call(peopleImport.POST, "POST", "/x", {})
    expect(preview.body.conflicts).toEqual([{ email: "dave.alias@liatrio.com", person_ids: [PE.dave], unmatched_cost_usd: 3 }])
    expect(preview.body.candidates.map((c: { email: string }) => c.email)).not.toContain("dave.alias@liatrio.com")

    const res = await call(peopleImport.POST, "POST", "/x", { confirm: true, emails: ["dave.alias@liatrio.com"] })
    expect(res.body.created).toEqual([])
    expect(res.body.skipped).toEqual(["dave.alias@liatrio.com"])
    expect(rows("people").some((p) => p.email === "dave.alias@liatrio.com")).toBe(false)
  })

  it("validates the request", async () => {
    const res = await call(peopleImport.POST, "POST", "/x", { confirm: true, emails: ["nope"] })
    expect(res.status).toBe(400)
    expect(writesTo("people")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Unassigned queue
// ---------------------------------------------------------------------------

describe("unassigned queue", () => {
  it("groups the month's team-less spend by person email, API key and project, with totals", async () => {
    const res = await call(unassigned.GET, "GET", `/api/admin/org/unassigned?month=${MONTH}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      month: MONTH,
      org_total_usd: 54.25,
      unassigned_total_usd: 32.5,
      subtotals: { person: 15.5, api_key: 5, project: 4, other: 8 },
    })
    const groups = res.body.groups.map((g: Record<string, unknown>) => [g.kind, g.key, g.total_cost_usd, g.record_count])
    expect(groups).toEqual([
      ["person", "new.person@liatrio.com", 15, 2],
      ["other", "other", 8, 2],
      ["project", `${P.openai}:proj_9`, 4, 1],
      ["api_key", `${P.openai}:key_bare`, 3, 1],
      ["api_key", `${P.openai}:key_unknown`, 2, 1],
      ["person", "carol@liatrio.com", 0.5, 1],
    ])
    const carol = res.body.groups.find((g: { key: string }) => g.key === "carol@liatrio.com")
    // carol has no display_name in the TS fixture, so the label falls back to the email.
    expect(carol).toMatchObject({ person_id: PE.carol, label: "carol@liatrio.com", email: "carol@liatrio.com" })
    const bare = res.body.groups.find((g: { key: string }) => g.key.endsWith("key_bare"))
    expect(bare).toMatchObject({ registered_id: K.bare, label: "Unowned key", external_id: "key_bare", provider_id: P.openai })
    const sum = res.body.groups.reduce((s: number, g: { total_cost_usd: number }) => s + g.total_cost_usd, 0)
    expect(sum).toBeCloseTo(res.body.unassigned_total_usd, 6)
  })

  it("rejects a bad month", async () => {
    const res = await call(unassigned.GET, "GET", "/x?month=2026-13")
    expect(res).toMatchObject({ status: 400, body: { error: "month must be YYYY-MM" } })
  })

  it("one-click assign clears each kind from the queue", async () => {
    const steps = [
      { kind: "person", email: "new.person@liatrio.com", display_name: "New Person", team_id: T.platform },
      { kind: "person", email: "carol@liatrio.com", team_id: T.platform },
      { kind: "api_key", provider_id: P.openai, external_key_id: "key_bare", team_id: T.data },
      { kind: "api_key", provider_id: P.openai, external_key_id: "key_unknown", name: "CI key", team_id: T.data },
      { kind: "project", provider_id: P.openai, external_project_id: "proj_9", name: "Experiments", team_id: T.field },
    ]
    const statuses = []
    for (const s of steps) statuses.push((await call(assign.POST, "POST", "/x", s)).status)
    expect(statuses).toEqual([201, 200, 200, 201, 201])
    expect(rows("people").find((p) => p.email === "new.person@liatrio.com")).toMatchObject({ team_id: T.platform, display_name: "New Person" })
    expect(rows("people").find((p) => p.id === PE.carol)?.team_id).toBe(T.platform)

    const res = await call(unassigned.GET, "GET", `/x?month=${MONTH}`)
    expect(res.body.groups.map((g: { kind: string }) => g.kind)).toEqual(["other"])
    expect(res.body.unassigned_total_usd).toBe(8)
    expect(res.body.org_total_usd).toBe(54.25)
  })

  it("assign validates kind and team", async () => {
    const badKind = await call(assign.POST, "POST", "/x", { kind: "workspace", team_id: T.data })
    expect(badKind.status).toBe(400)
    const badTeam = await call(assign.POST, "POST", "/x", { kind: "person", email: "x@liatrio.com", team_id: "t-x" })
    expect(badTeam).toMatchObject({ status: 400, body: { error: "Unknown team id: t-x" } })
    expect(mockState.db.writes).toEqual([])
  })
})

describe("GET /api/admin/org", () => {
  it("returns the whole structure", async () => {
    const res = await call(orgRoot.GET, "GET", "/x")
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(
      ["apiKeys", "departments", "identities", "people", "projects", "providers", "teams"]
    )
    expect(res.body.teams).toHaveLength(4)
  })
})

describe("database errors", () => {
  it("maps a unique violation that slips past validation (a concurrent insert) to 409", async () => {
    jest.spyOn(mockState.db, "uniqueViolation").mockReturnValueOnce("departments_name_key")
    const res = await call(departments.POST, "POST", "/x", { name: "Racing" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("That already exists")
  })
})

// ---------------------------------------------------------------------------
// Issue #24: manual source flag and the AI Gateway key sync
// ---------------------------------------------------------------------------

describe("gateway key attribution (#24)", () => {
  const GW = "prov-aigw"
  const keyByExt = (ext: string) => rows("org_api_keys").find((k) => k.external_key_id === ext) as Record<string, unknown>

  it("POST keys: setting owner, team or project marks the key manual; a rename alone does not", async () => {
    const renamed = await call(keys.POST, "POST", "/x", { provider_id: P.openai, external_key_id: "key_new", name: "Only a name" })
    expect(renamed.status).toBe(201)
    expect(keyByExt("key_new").assignment_source).toBeUndefined()

    const owned = await call(keys.POST, "POST", "/x", { provider_id: P.openai, external_key_id: "key_bare", owner_person_id: PE.carol })
    expect(owned.status).toBe(200)
    expect(keyByExt("key_bare")).toMatchObject({ owner_person_id: PE.carol, assignment_source: "manual" })

    const projected = await call(keys.POST, "POST", "/x", { provider_id: P.openai, external_key_id: "key_new", org_project_id: PR.sales })
    expect(projected.status).toBe(200)
    expect(keyByExt("key_new")).toMatchObject({ org_project_id: PR.sales, assignment_source: "manual" })
  })

  it("POST keys: a project from another provider or an unknown project is a 400", async () => {
    const cross = await call(keys.POST, "POST", "/x", { provider_id: P.anthropic, external_key_id: "k", org_project_id: PR.sales })
    expect(cross.status).toBe(400)
    expect(cross.body.error).toMatch(/different provider/)
    const unknown = await call(keys.POST, "POST", "/x", { provider_id: P.openai, external_key_id: "k", org_project_id: "nope" })
    expect(unknown.status).toBe(400)
  })

  it("Unassigned queue assign marks an API key manual", async () => {
    const res = await call(assign.POST, "POST", "/x", { kind: "api_key", provider_id: P.openai, external_key_id: "key_bare", team_id: T.data })
    expect(res.status).toBe(200)
    expect(keyByExt("key_bare")).toMatchObject({ team_id: T.data, assignment_source: "manual" })
    const created = await call(assign.POST, "POST", "/x", { kind: "api_key", provider_id: P.openai, external_key_id: "key_unknown", team_id: T.data })
    expect(created.status).toBe(201)
    expect(keyByExt("key_unknown").assignment_source).toBe("manual")
  })

  describe("POST /keys/sync-gateway", () => {
    const realFetch = global.fetch
    const savedToken = process.env.VERCEL_TOKEN
    const savedTeam = process.env.VERCEL_TEAM_ID
    afterEach(() => {
      global.fetch = realFetch
      if (savedToken === undefined) delete process.env.VERCEL_TOKEN
      else process.env.VERCEL_TOKEN = savedToken
      if (savedTeam === undefined) delete process.env.VERCEL_TEAM_ID
      else process.env.VERCEL_TEAM_ID = savedTeam
    })
    const res = (body: unknown, status = 200) =>
      ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

    it("400 without VERCEL_TOKEN", async () => {
      delete process.env.VERCEL_TOKEN
      const r = await call(syncGateway.POST, "POST", "/x")
      expect(r.status).toBe(400)
      expect(JSON.stringify(r.body)).not.toMatch(/test-vercel-token/)
    })

    it("syncs keys, keeps manual assignments and refreshes the rollups", async () => {
      process.env.VERCEL_TOKEN = "test-vercel-token"
      process.env.VERCEL_TEAM_ID = "team_x"
      rows("providers").push({ id: GW, name: "vercel-ai-gateway", display_name: "Vercel AI Gateway" })
      rows("org_api_keys").push({
        id: "gk-manual", provider_id: GW, external_key_id: "k_manual", name: "manual", owner_person_id: null,
        team_id: T.field, org_project_id: null, assignment_source: "manual",
      })
      global.fetch = jest.fn(async (url: unknown) => {
        const u = new URL(String(url))
        if (u.pathname === "/v1/api-keys") {
          return res({
            apiKeys: [
              { id: "k_alice", name: "alice", createdBy: "uid_alice", metadata: { spendAttribution: "user" } },
              { id: "k_manual", name: "manual", createdBy: "uid_alice", metadata: { spendAttribution: "user" } },
            ],
          })
        }
        if (u.pathname === "/v3/teams/team_x/members") return res({ members: [{ uid: "uid_alice", email: "alice@liatrio.com" }] })
        throw new Error(`unexpected fetch ${u}`)
      }) as unknown as typeof fetch

      const r = await call(syncGateway.POST, "POST", "/x")
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ status: "success", keys_listed: 2, keys_inserted: 1, keys_manual: 1 })
      expect(keyByExt("k_alice")).toMatchObject({ owner_person_id: PE.alice, assignment_source: "auto" })
      expect(keyByExt("k_manual")).toMatchObject({ owner_person_id: null, team_id: T.field, assignment_source: "manual" })
      expect(mockState.refreshes).toBe(1)
    })

    it("issue #28: a Vercel failure is a 502 with the reason, and nothing is written", async () => {
      process.env.VERCEL_TOKEN = "test-vercel-token"
      rows("providers").push({ id: GW, name: "vercel-ai-gateway", display_name: "Vercel AI Gateway" })
      global.fetch = jest.fn(async () => res({ error: "nope" }, 403)) as unknown as typeof fetch
      const before = mockState.db.writes.length
      const r = await call(syncGateway.POST, "POST", "/x")
      expect(r.status).toBe(502)
      expect(r.body.error).toMatch(/nothing was changed.*HTTP 403/)
      expect(JSON.stringify(r.body)).not.toMatch(/test-vercel-token/)
      expect(mockState.db.writes.length).toBe(before)
      expect(mockState.refreshes).toBe(0)
    })
  })

  describe("issue #32: POST /keys/sync (Anthropic + Vercel) and /keys/assign-creator", () => {
    const realFetch = global.fetch
    const saved = { an: process.env.ANTHROPIC_ADMIN_KEY, vt: process.env.VERCEL_TOKEN, team: process.env.VERCEL_TEAM_ID }
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v))
    afterEach(() => {
      global.fetch = realFetch
      restore("ANTHROPIC_ADMIN_KEY", saved.an)
      restore("VERCEL_TOKEN", saved.vt)
      restore("VERCEL_TEAM_ID", saved.team)
    })
    beforeEach(() => {
      process.env.ANTHROPIC_ADMIN_KEY = "test-admin-key"
      process.env.VERCEL_TOKEN = "test-vercel-token"
      process.env.VERCEL_TEAM_ID = "team_x"
      rows("providers").push({ id: GW, name: "vercel-ai-gateway", display_name: "Vercel AI Gateway" })
    })
    const res = (body: unknown, status = 200) =>
      ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

    const providerFetch = (opts: { anthropicFails?: boolean } = {}) =>
      jest.fn(async (url: unknown) => {
        const u = new URL(String(url))
        if (u.hostname === "api.anthropic.com") {
          if (u.pathname === "/v1/organizations/api_keys") {
            if (opts.anthropicFails) return res({ error: { type: "permission_error" } }, 403)
            return res({
              data: [
                { id: "an_alice", name: "alice key", status: "active", workspace_id: "wrk_1", created_by: { id: "user_alice", type: "user" } },
                { id: "an_svc", name: "ci", status: "archived", workspace_id: null, created_by: { id: "sa_1", type: "service_account" } },
              ],
              has_more: false,
            })
          }
          if (u.pathname === "/v1/organizations/users") return res({ data: [{ id: "user_alice", email: "alice@liatrio.com", name: "Alice" }], has_more: false })
          if (u.pathname === "/v1/organizations/workspaces") return res({ data: [{ id: "wrk_1", name: "Workspace One" }], has_more: false })
        }
        if (u.pathname === "/v1/api-keys") {
          return res({
            apiKeys: [
              { id: "gk_team", name: "shared", createdBy: "uid_carol", metadata: { spendAttribution: "team" } },
              { id: "gk_unset", name: "legacy", createdBy: "uid_carol" },
              { id: "gk_user", name: "mine", createdBy: "uid_carol", metadata: { spendAttribution: "user" } },
            ],
          })
        }
        if (u.pathname === "/v3/teams/team_x/members") return res({ members: [{ uid: "uid_carol", email: "carol@liatrio.com" }] })
        throw new Error(`unexpected fetch ${u}`)
      }) as unknown as typeof fetch

    it("syncs both providers and returns per-provider counts", async () => {
      global.fetch = providerFetch()
      const r = await call(syncKeys.POST, "POST", "/x")
      expect(r.status).toBe(200)
      expect(r.body.providers.anthropic).toMatchObject({ status: "success", created: 2, updated: 0, unchanged: 0, manual_kept: 0, unresolved_creators: 1 })
      expect(r.body.providers["vercel-ai-gateway"]).toMatchObject({ status: "success", created: 3, updated: 0, unchanged: 0, manual_kept: 0, unresolved_creators: 0 })
      // Issue #34: the creator is every gateway key's default owner (team and unset included).
      expect(r.body.providers["vercel-ai-gateway"]).toMatchObject({ creator_default_assigned: 2 })
      for (const ext of ["gk_team", "gk_unset", "gk_user"]) expect(keyByExt(ext)).toMatchObject({ owner_person_id: PE.carol, assignment_source: "auto" })
      expect(keyByExt("an_alice")).toMatchObject({ owner_person_id: PE.alice, assignment_source: "auto" })
      expect(keyByExt("an_svc")).toMatchObject({ owner_person_id: null, unresolved_reason: "service_account", external_status: "archived" })
      expect(JSON.stringify(r.body)).not.toMatch(/test-admin-key|test-vercel-token/)
      expect(mockState.refreshes).toBe(1)

      const again = await call(syncKeys.POST, "POST", "/x")
      expect(again.body.providers.anthropic).toMatchObject({ created: 0, updated: 0, unchanged: 2 })
      expect(again.body.providers["vercel-ai-gateway"]).toMatchObject({ created: 0, updated: 0, unchanged: 3 })
    })

    it("an Anthropic Admin API error is a 502 and nothing is written (Vercel included)", async () => {
      global.fetch = providerFetch({ anthropicFails: true })
      const before = mockState.db.writes.length
      const r = await call(syncKeys.POST, "POST", "/x")
      expect(r.status).toBe(502)
      expect(r.body.error).toMatch(/Anthropic key sync failed, nothing was changed.*HTTP 403/)
      expect(JSON.stringify(r.body)).not.toMatch(/test-admin-key/)
      expect(mockState.db.writes.length).toBe(before)
      expect(mockState.refreshes).toBe(0)
    })

    it("skips an unconfigured provider, and 400s when it is asked for by name", async () => {
      delete process.env.ANTHROPIC_ADMIN_KEY
      global.fetch = providerFetch()
      const r = await call(syncKeys.POST, "POST", "/x")
      expect(r.status).toBe(200)
      expect(r.body.providers.anthropic).toEqual({ status: "skipped", reason: "ANTHROPIC_ADMIN_KEY is not configured" })
      expect(r.body.providers["vercel-ai-gateway"]).toMatchObject({ created: 3 })
      const named = await call(syncKeys.POST, "POST", "/x", { providers: ["anthropic"] })
      expect(named.status).toBe(400)
    })

    it("Assign to creator (issue #34): an override for keys not owned by their creator, sets a manual owner that a later sync keeps", async () => {
      global.fetch = providerFetch()
      await call(syncKeys.POST, "POST", "/x", { providers: ["vercel-ai-gateway"] })
      expect(keyByExt("gk_team")).toMatchObject({ owner_person_id: PE.carol, assignment_source: "auto", external_created_by_email: "carol@liatrio.com" })
      // Already owned by the creator (auto): not eligible, whatever the spend attribution.
      for (const ext of ["gk_team", "gk_unset", "gk_user"]) {
        expect((await call(assignCreator.POST, "POST", "/x", { provider_id: GW, external_key_id: ext })).status).toBe(409)
      }

      // An admin handed gk_team to Alice: the override hands it back to the creator, manual.
      Object.assign(keyByExt("gk_team"), { owner_person_id: PE.alice, assignment_source: "manual" })
      const ok = await call(assignCreator.POST, "POST", "/x", { provider_id: GW, external_key_id: "gk_team" })
      expect(ok.status).toBe(200)
      expect(keyByExt("gk_team")).toMatchObject({ owner_person_id: PE.carol, assignment_source: "manual" })
      expect((await call(assignCreator.POST, "POST", "/x", { provider_id: GW, external_key_id: "gk_team" })).status).toBe(409)

      // An unowned user key (owner cleared by hand) is eligible too.
      Object.assign(keyByExt("gk_user"), { owner_person_id: null, assignment_source: "manual" })
      expect((await call(assignCreator.POST, "POST", "/x", { provider_id: GW, external_key_id: "gk_user" })).status).toBe(200)
      expect(keyByExt("gk_user")).toMatchObject({ owner_person_id: PE.carol, assignment_source: "manual" })

      // Unregistered key.
      expect((await call(assignCreator.POST, "POST", "/x", { provider_id: GW, external_key_id: "nope" })).status).toBe(404)
      // No creator email.
      Object.assign(keyByExt("gk_unset"), { owner_person_id: null, external_created_by_email: null, assignment_source: "manual" })
      expect((await call(assignCreator.POST, "POST", "/x", { provider_id: GW, external_key_id: "gk_unset" })).status).toBe(409)

      const resync = await call(syncKeys.POST, "POST", "/x", { providers: ["vercel-ai-gateway"] })
      expect(resync.body.providers["vercel-ai-gateway"]).toMatchObject({ manual_kept: 3 })
      expect(keyByExt("gk_team")).toMatchObject({ owner_person_id: PE.carol, assignment_source: "manual", spend_attribution: "team" })
      expect(keyByExt("gk_user")).toMatchObject({ owner_person_id: PE.carol, assignment_source: "manual" })
      const third = await call(syncKeys.POST, "POST", "/x", { providers: ["vercel-ai-gateway"] })
      expect(third.body.providers["vercel-ai-gateway"]).toMatchObject({ updated: 0, unchanged: 3 })
    })

    it("Assign to creator creates the creator's person when there is none (no team)", async () => {
      global.fetch = providerFetch()
      await call(syncKeys.POST, "POST", "/x", { providers: ["vercel-ai-gateway"] })
      Object.assign(keyByExt("gk_unset"), { external_created_by_email: "Fresh.Person@liatrio.com" })
      const r = await call(assignCreator.POST, "POST", "/x", { provider_id: GW, external_key_id: "gk_unset" })
      expect(r).toMatchObject({ status: 200, body: { person_created: true } })
      const p = rows("people").find((x) => x.email === "fresh.person@liatrio.com") as Record<string, unknown>
      expect(p).toBeTruthy()
      expect(p.team_id ?? null).toBeNull()
      expect(keyByExt("gk_unset")).toMatchObject({ owner_person_id: p.id, assignment_source: "manual" })
    })

    it("Assign to creator rejects non-gateway keys", async () => {
      rows("org_api_keys").push({ id: "an-1", provider_id: P.anthropic, external_key_id: "an_x", name: "x", owner_person_id: null, team_id: null, external_created_by_email: "carol@liatrio.com", spend_attribution: null })
      const r = await call(assignCreator.POST, "POST", "/x", { provider_id: P.anthropic, external_key_id: "an_x" })
      expect(r.status).toBe(409)
    })
  })
})
