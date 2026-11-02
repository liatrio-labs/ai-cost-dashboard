/**
 * @jest-environment node
 *
 * Route handler tests for /api/admin/org/* (issue #7). Auth runs through the
 * real requireAdmin with @supabase/ssr mocked; writes hit an in-memory fake
 * service-role client. No network, no database.
 */

import { NextRequest } from "next/server"
import { FakeSupabase } from "@/lib/org/fake-supabase"
import { novemberRecords } from "@/lib/org/observed-fixtures"
import { D, K, P, PE, T, orgData } from "@/lib/org/test-fixtures"
import { refreshDailyAggregates } from "@/lib/supabase/admin"

import * as orgRoute from "../route"
import * as departmentsRoute from "../departments/route"
import * as departmentRoute from "../departments/[id]/route"
import * as teamsRoute from "../teams/route"
import * as teamRoute from "../teams/[id]/route"
import * as peopleRoute from "../people/route"
import * as personRoute from "../people/[id]/route"
import * as importRoute from "../people/import/route"
import * as identitiesRoute from "../identities/route"
import * as identityRoute from "../identities/[id]/route"
import * as apiKeysRoute from "../api-keys/route"
import * as apiKeyRoute from "../api-keys/[id]/route"
import * as unassignedRoute from "../unassigned/route"
import * as assignRoute from "../unassigned/assign/route"

let mockUser: { id: string; email: string } | null = null
let mockDb: FakeSupabase

jest.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}))
jest.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: mockUser }, error: null }) },
  }),
}))
jest.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockDb,
  refreshDailyAggregates: jest.fn(async () => undefined),
}))

const ADMIN = { id: "u-admin", email: "admin@liatrio.com" }
const OUTSIDER = { id: "u-out", email: "someone@example.com" }

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
  process.env.ADMIN_DOMAINS = "liatrio.com"
})
afterAll(() => {
  process.env = savedEnv
})

function seed() {
  const org = orgData()
  return new FakeSupabase({
    providers: [
      { id: P.anthropic, name: "anthropic", display_name: "Anthropic" },
      { id: P.openai, name: "openai", display_name: "OpenAI" },
      { id: P.cursor, name: "cursor", display_name: "Cursor" },
    ],
    departments: org.departments,
    teams: org.teams,
    people: org.people.map((p) => ({ active: true, ...p })),
    person_identities: org.identities.map((i, n) => ({ id: `ident-${n}`, ...i })),
    org_api_keys: org.apiKeys,
    cost_records: [
      ...novemberRecords().map((r, n) => ({ id: `cr-${String(n).padStart(3, "0")}`, ...r })),
      // October: outside the November window
      {
        id: "cr-oct",
        provider_id: P.cursor,
        timestamp: "2026-10-15T00:00:00Z",
        cost_usd: 100,
        metadata: { attribution: { granularity: "person", person_email: "olde@liatrio.com" } },
      },
    ],
  })
}

beforeEach(() => {
  mockUser = ADMIN
  mockDb = seed()
  jest.mocked(refreshDailyAggregates).mockClear()
})

function req(path: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  })
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

async function json(res: Response) {
  return { status: res.status, body: await res.json() }
}

// ---------------------------------------------------------------------------
// Auth: every handler is behind requireAdmin
// ---------------------------------------------------------------------------

const ALL_HANDLERS: [string, () => Promise<Response>][] = [
  ["GET /org", () => orgRoute.GET()],
  ["POST /departments", () => departmentsRoute.POST(req("/x", "POST", { name: "X" }))],
  ["PATCH /departments/:id", () => departmentRoute.PATCH(req("/x", "PATCH", { name: "X" }), ctx(D.eng))],
  ["DELETE /departments/:id", () => departmentRoute.DELETE(req("/x", "DELETE"), ctx(D.eng))],
  ["POST /teams", () => teamsRoute.POST(req("/x", "POST", { name: "X" }))],
  ["PATCH /teams/:id", () => teamRoute.PATCH(req("/x", "PATCH", { name: "X" }), ctx(T.data))],
  ["DELETE /teams/:id", () => teamRoute.DELETE(req("/x", "DELETE"), ctx(T.data))],
  ["POST /people", () => peopleRoute.POST(req("/x", "POST", { email: "x@liatrio.com" }))],
  ["PATCH /people/:id", () => personRoute.PATCH(req("/x", "PATCH", { active: false }), ctx(PE.alice))],
  ["GET /people/import", () => importRoute.GET(req("/x"))],
  ["POST /people/import", () => importRoute.POST(req("/x", "POST", { confirm: true }))],
  ["POST /identities", () => identitiesRoute.POST(req("/x", "POST", {}))],
  ["DELETE /identities/:id", () => identityRoute.DELETE(req("/x", "DELETE"), ctx("ident-0"))],
  ["GET /api-keys", () => apiKeysRoute.GET(req("/x"))],
  ["POST /api-keys", () => apiKeysRoute.POST(req("/x", "POST", {}))],
  ["PATCH /api-keys/:id", () => apiKeyRoute.PATCH(req("/x", "PATCH", { team_id: null }), ctx(K.team))],
  ["DELETE /api-keys/:id", () => apiKeyRoute.DELETE(req("/x", "DELETE"), ctx(K.team))],
  ["GET /unassigned", () => unassignedRoute.GET(req("/x"))],
  ["POST /unassigned/assign", () => assignRoute.POST(req("/x", "POST", {}))],
]

describe("auth", () => {
  it.each(ALL_HANDLERS)("%s returns 401 when unauthenticated and writes nothing", async (_name, call) => {
    mockUser = null
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
    expect(mockDb.writes()).toEqual([])
  })

  it.each(ALL_HANDLERS)("%s returns 403 for a non-admin and writes nothing", async (_name, call) => {
    mockUser = OUTSIDER
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(mockDb.writes()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe("GET /api/admin/org", () => {
  it("returns the org and providers", async () => {
    const { status, body } = await json(await orgRoute.GET())
    expect(status).toBe(200)
    expect(body.departments.map((d: { name: string }) => d.name)).toEqual(["Engineering", "Sales"])
    expect(body.teams).toHaveLength(4)
    expect(body.people).toHaveLength(5)
    expect(body.identities).toHaveLength(2)
    expect(body.apiKeys).toHaveLength(3)
    expect(body.providers).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

describe("departments", () => {
  it("creates, renames and deletes an empty department", async () => {
    const created = await json(await departmentsRoute.POST(req("/x", "POST", { name: " Marketing ", description: "Brand" })))
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ name: "Marketing", description: "Brand" })
    const id = created.body.id

    const renamed = await json(await departmentRoute.PATCH(req("/x", "PATCH", { name: "Growth" }), ctx(id)))
    expect(renamed).toMatchObject({ status: 200, body: { id, name: "Growth" } })

    const deleted = await json(await departmentRoute.DELETE(req("/x", "DELETE"), ctx(id)))
    expect(deleted).toMatchObject({ status: 200, body: { deleted: id, teams_unassigned: 0 } })
    expect(mockDb.table("departments").map((d) => d.name)).toEqual(["Engineering", "Sales"])
  })

  it("rejects a duplicate department name and an empty name", async () => {
    expect((await departmentsRoute.POST(req("/x", "POST", { name: "sales" }))).status).toBe(400)
    expect((await departmentsRoute.POST(req("/x", "POST", { name: "  " }))).status).toBe(400)
    expect((await departmentRoute.PATCH(req("/x", "PATCH", { name: "Sales" }), ctx(D.eng))).status).toBe(400)
    expect(mockDb.writes()).toEqual([])
  })

  it("returns 404 for an unknown department and 400 for a non-JSON body", async () => {
    expect((await departmentRoute.PATCH(req("/x", "PATCH", { name: "Z" }), ctx("nope"))).status).toBe(404)
    expect((await departmentRoute.DELETE(req("/x", "DELETE"), ctx("nope"))).status).toBe(404)
    const bad = new NextRequest("http://localhost/x", { method: "POST", body: "{not json" })
    expect((await departmentsRoute.POST(bad)).status).toBe(400)
  })

  it("blocks deleting a department that still has teams unless confirmed", async () => {
    const blocked = await json(await departmentRoute.DELETE(req("/x", "DELETE"), ctx(D.eng)))
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ blocked: true, teams: 2 })
    expect(blocked.body.error).toMatch(/still has 2 team/)
    expect(mockDb.writes()).toEqual([])

    const ok = await json(await departmentRoute.DELETE(req("/x?confirm=true", "DELETE"), ctx(D.eng)))
    expect(ok).toMatchObject({ status: 200, body: { teams_unassigned: 2 } })
    expect(mockDb.table("departments").some((d) => d.id === D.eng)).toBe(false)
    const moved = mockDb.table("teams").filter((t) => t.id === T.platform || t.id === T.data)
    expect(moved.map((t) => t.department_id)).toEqual([null, null])
  })
})

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

describe("teams", () => {
  it("creates a team in a department, renames it, moves it, and deletes it when empty", async () => {
    const created = await json(await teamsRoute.POST(req("/x", "POST", { name: "Security", department_id: D.eng })))
    expect(created).toMatchObject({ status: 201, body: { name: "Security", department_id: D.eng } })
    const id = created.body.id

    expect((await json(await teamRoute.PATCH(req("/x", "PATCH", { name: "SecOps" }), ctx(id)))).body.name).toBe("SecOps")
    const moved = await json(await teamRoute.PATCH(req("/x", "PATCH", { department_id: D.sales }), ctx(id)))
    expect(moved.body.department_id).toBe(D.sales)
    expect(refreshDailyAggregates).toHaveBeenCalled()

    const deleted = await json(await teamRoute.DELETE(req("/x", "DELETE"), ctx(id)))
    expect(deleted).toMatchObject({ status: 200, body: { deleted: id, people_unassigned: 0, api_keys_unassigned: 0 } })
  })

  it("can move a team out of any department", async () => {
    const res = await json(await teamRoute.PATCH(req("/x", "PATCH", { department_id: null }), ctx(T.field)))
    expect(res.body.department_id).toBeNull()
  })

  it("rejects a duplicate team name in a department and an unknown department id", async () => {
    const dup = await json(await teamsRoute.POST(req("/x", "POST", { name: "PLATFORM", department_id: D.eng })))
    expect(dup.status).toBe(400)
    expect(dup.body.error).toMatch(/already exists in this department/)
    const moveDup = await teamRoute.PATCH(req("/x", "PATCH", { department_id: D.eng, name: "Data" }), ctx(T.field))
    expect(moveDup.status).toBe(400)
    const unknown = await json(await teamsRoute.POST(req("/x", "POST", { name: "Ops", department_id: "dept-nope" })))
    expect(unknown).toMatchObject({ status: 400, body: { error: "Unknown department id" } })
    expect(mockDb.writes()).toEqual([])
  })

  it("blocks deleting a non-empty team unless confirmed, then moves members to Unassigned", async () => {
    // Data has Dave and the key_team API key.
    const blocked = await json(await teamRoute.DELETE(req("/x", "DELETE"), ctx(T.data)))
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ blocked: true, people: 1, api_keys: 1 })
    expect(blocked.body.error).toMatch(/still has 1 person\(s\) and 1 API key\(s\)/)
    expect(mockDb.writes()).toEqual([])
    expect(mockDb.table("teams").some((t) => t.id === T.data)).toBe(true)

    // confirm=false is not a confirmation
    expect((await teamRoute.DELETE(req("/x?confirm=false", "DELETE"), ctx(T.data))).status).toBe(409)

    const ok = await json(await teamRoute.DELETE(req("/x?confirm=true", "DELETE"), ctx(T.data)))
    expect(ok).toMatchObject({ status: 200, body: { people_unassigned: 1, api_keys_unassigned: 1 } })
    expect(mockDb.table("teams").some((t) => t.id === T.data)).toBe(false)
    expect(mockDb.table("people").find((p) => p.id === PE.dave)!.team_id).toBeNull()
    expect(mockDb.table("org_api_keys").find((k) => k.id === K.team)!.team_id).toBeNull()
    expect(refreshDailyAggregates).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// People and identities
// ---------------------------------------------------------------------------

describe("people", () => {
  it("adds a person (normalizing email), assigns a team, edits and deactivates", async () => {
    const created = await json(
      await peopleRoute.POST(req("/x", "POST", { email: "  Frank@Liatrio.com ", display_name: "Frank", team_id: T.platform }))
    )
    expect(created).toMatchObject({
      status: 201,
      body: { email: "frank@liatrio.com", display_name: "Frank", team_id: T.platform, active: true },
    })
    const id = created.body.id

    const moved = await json(await personRoute.PATCH(req("/x", "PATCH", { team_id: T.field, display_name: "Frank F." }), ctx(id)))
    expect(moved.body).toMatchObject({ team_id: T.field, display_name: "Frank F." })

    const off = await json(await personRoute.PATCH(req("/x", "PATCH", { active: false }), ctx(id)))
    expect(off.body.active).toBe(false)
    expect(mockDb.table("people")).toHaveLength(6)
  })

  it("rejects an invalid email, a duplicate email and an unknown team id", async () => {
    const bad = await json(await peopleRoute.POST(req("/x", "POST", { email: "nope" })))
    expect(bad).toMatchObject({ status: 400, body: { error: "Invalid email address" } })
    expect((await peopleRoute.POST(req("/x", "POST", { email: "Alice@liatrio.com" }))).status).toBe(400)
    const team = await json(await peopleRoute.POST(req("/x", "POST", { email: "g@liatrio.com", team_id: "team-nope" })))
    expect(team).toMatchObject({ status: 400, body: { error: "Unknown team id" } })
    expect((await personRoute.PATCH(req("/x", "PATCH", { team_id: "team-nope" }), ctx(PE.alice))).status).toBe(400)
    expect((await personRoute.PATCH(req("/x", "PATCH", {}), ctx(PE.alice))).status).toBe(400)
    expect((await personRoute.PATCH(req("/x", "PATCH", { active: false }), ctx("p-nope"))).status).toBe(404)
    expect(mockDb.writes()).toEqual([])
  })

  it("adds and removes identity mappings", async () => {
    const created = await json(
      await identitiesRoute.POST(req("/x", "POST", { person_id: PE.carol, provider_id: P.anthropic, external_id: "user_carol" }))
    )
    expect(created).toMatchObject({ status: 201, body: { person_id: PE.carol, external_id: "user_carol" } })

    const dup = await identitiesRoute.POST(req("/x", "POST", { person_id: PE.alice, provider_id: P.anthropic, external_id: "user_bob" }))
    expect(dup.status).toBe(400)
    const unknownProvider = await identitiesRoute.POST(
      req("/x", "POST", { person_id: PE.alice, provider_id: "prov-nope", external_id: "u" })
    )
    expect(unknownProvider.status).toBe(400)

    expect((await identityRoute.DELETE(req("/x", "DELETE"), ctx(created.body.id))).status).toBe(200)
    expect((await identityRoute.DELETE(req("/x", "DELETE"), ctx(created.body.id))).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Import from observed data
// ---------------------------------------------------------------------------

describe("people import from observed data", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: new Date("2026-11-20T00:00:00Z"), doNotFake: ["nextTick", "setImmediate"] })
  })
  afterAll(() => {
    jest.useRealTimers()
  })

  it("dry run lists distinct observed emails and creates nothing", async () => {
    for (const res of [await importRoute.GET(req("/x")), await importRoute.POST(req("/x", "POST", {}))]) {
      const { status, body } = await json(res)
      expect(status).toBe(200)
      expect(body.dry_run).toBe(true)
      expect(body.candidates.map((c: { email: string }) => c.email)).toEqual([
        "alice@liatrio.com",
        "carol@liatrio.com",
        "olde@liatrio.com",
        "zed@liatrio.com",
      ])
      expect(body.to_create).toBe(2)
      expect(body.created).toEqual([])
    }
    expect(mockDb.writes()).toEqual([])
    expect(mockDb.table("people")).toHaveLength(5)
  })

  it("respects the lookback window", async () => {
    const { body } = await json(await importRoute.GET(req("/x?days=10")))
    expect(body.candidates.map((c: { email: string }) => c.email)).not.toContain("olde@liatrio.com")
  })

  it("creates the new people only once confirmed, named from person_name", async () => {
    const { status, body } = await json(await importRoute.POST(req("/x", "POST", { confirm: true, team_id: T.field })))
    expect(status).toBe(201)
    expect(body.dry_run).toBe(false)
    expect(body.created.map((p: { email: string }) => p.email).sort()).toEqual(["olde@liatrio.com", "zed@liatrio.com"])
    const zed = mockDb.table("people").find((p) => p.email === "zed@liatrio.com")!
    expect(zed).toMatchObject({ display_name: "Zed", team_id: T.field, active: true })
    expect(mockDb.table("people")).toHaveLength(7)
    expect(refreshDailyAggregates).toHaveBeenCalledTimes(1)

    // Re-running finds nothing new.
    const again = await json(await importRoute.POST(req("/x", "POST", { confirm: true })))
    expect(again.body).toMatchObject({ to_create: 0, created: [] })
  })

  it("can confirm a subset and rejects an unknown team", async () => {
    const subset = await json(await importRoute.POST(req("/x", "POST", { confirm: true, emails: ["ZED@liatrio.com"] })))
    expect(subset.body.created.map((p: { email: string }) => p.email)).toEqual(["zed@liatrio.com"])
    const bad = await importRoute.POST(req("/x", "POST", { confirm: true, team_id: "team-nope" }))
    expect(bad.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

describe("api keys", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: new Date("2026-11-20T00:00:00Z"), doNotFake: ["nextTick", "setImmediate"] })
  })
  afterAll(() => {
    jest.useRealTimers()
  })

  it("lists observed and registered keys", async () => {
    const { status, body } = await json(await apiKeysRoute.GET(req("/x")))
    expect(status).toBe(200)
    expect(body.keys.map((k: { external_key_id: string }) => k.external_key_id).sort()).toEqual([
      "key_bare",
      "key_new",
      "key_owner",
      "key_team",
    ])
    expect(body.keys.find((k: { external_key_id: string }) => k.external_key_id === "key_new")).toMatchObject({
      registered: false,
      name: "CI key",
      provider_id: P.openai,
    })
  })

  it("registers an observed key with an owner and team, then updates and unregisters it", async () => {
    const created = await json(
      await apiKeysRoute.POST(
        req("/x", "POST", { provider_id: P.openai, external_key_id: "key_new", name: "CI key", owner_person_id: PE.carol, team_id: T.data })
      )
    )
    expect(created).toMatchObject({ status: 201, body: { external_key_id: "key_new", owner_person_id: PE.carol, team_id: T.data } })

    // Same provider + key id updates in place.
    const updated = await json(
      await apiKeysRoute.POST(req("/x", "POST", { provider_id: P.openai, external_key_id: "key_new", team_id: T.field }))
    )
    expect(updated).toMatchObject({ status: 200, body: { id: created.body.id, team_id: T.field, owner_person_id: PE.carol } })

    const patched = await json(await apiKeyRoute.PATCH(req("/x", "PATCH", { owner_person_id: null }), ctx(created.body.id)))
    expect(patched.body.owner_person_id).toBeNull()

    expect((await apiKeyRoute.DELETE(req("/x", "DELETE"), ctx(created.body.id))).status).toBe(200)
    expect(mockDb.table("org_api_keys")).toHaveLength(3)
    expect(refreshDailyAggregates).toHaveBeenCalledTimes(4)
  })

  it("rejects unknown team, person and provider ids", async () => {
    const team = await apiKeyRoute.PATCH(req("/x", "PATCH", { team_id: "team-nope" }), ctx(K.bare))
    expect(team.status).toBe(400)
    const person = await apiKeysRoute.POST(
      req("/x", "POST", { provider_id: P.openai, external_key_id: "k", owner_person_id: "p-nope" })
    )
    expect(person.status).toBe(400)
    const provider = await apiKeysRoute.POST(req("/x", "POST", { provider_id: "prov-nope", external_key_id: "k" }))
    expect(provider.status).toBe(400)
    expect((await apiKeyRoute.PATCH(req("/x", "PATCH", { team_id: null }), ctx("k-nope"))).status).toBe(404)
    expect(mockDb.writes()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Unassigned queue
// ---------------------------------------------------------------------------

describe("unassigned queue", () => {
  it("returns the grouping and totals for the month", async () => {
    const { status, body } = await json(await unassignedRoute.GET(req("/x?month=2026-11")))
    expect(status).toBe(200)
    expect(body).toMatchObject({ month: "2026-11", total_cost_usd: 42.5, assigned_cost_usd: 16, unassigned_cost_usd: 26.5 })
    expect(body.groups.map((g: { key: string; total_cost_usd: number }) => [g.key, g.total_cost_usd])).toEqual([
      ["other", 8.5],
      ["person:carol@liatrio.com", 7.5],
      ["person:zed@liatrio.com", 4],
      [`api_key:${P.openai}:key_bare`, 3],
      [`api_key:${P.openai}:key_new`, 2],
      [`project:${P.openai}:proj_1`, 1.5],
    ])
  })

  it("only counts the requested month and validates the month", async () => {
    const oct = await json(await unassignedRoute.GET(req("/x?month=2026-10")))
    expect(oct.body).toMatchObject({ total_cost_usd: 100, unassigned_cost_usd: 100 })
    expect(oct.body.groups.map((g: { key: string }) => g.key)).toEqual(["person:olde@liatrio.com"])
    expect((await unassignedRoute.GET(req("/x?month=2026-13"))).status).toBe(400)
  })

  it("one-click assigns a person, a new email and a key, and the queue shrinks", async () => {
    const carol = await json(
      await assignRoute.POST(req("/x", "POST", { kind: "person", email: "carol@liatrio.com", team_id: T.platform }))
    )
    expect(carol).toMatchObject({ status: 200, body: { created: false, person: { id: PE.carol, team_id: T.platform } } })

    const zed = await json(
      await assignRoute.POST(req("/x", "POST", { kind: "person", email: "zed@liatrio.com", display_name: "Zed", team_id: T.field }))
    )
    expect(zed).toMatchObject({ body: { created: true, person: { email: "zed@liatrio.com", team_id: T.field } } })

    const key = await json(
      await assignRoute.POST(
        req("/x", "POST", { kind: "api_key", provider_id: P.openai, external_key_id: "key_new", name: "CI key", team_id: T.data })
      )
    )
    expect(key).toMatchObject({ body: { created: true, api_key: { external_key_id: "key_new", team_id: T.data } } })

    const bare = await json(
      await assignRoute.POST(req("/x", "POST", { kind: "api_key", provider_id: P.openai, external_key_id: "key_bare", team_id: T.data }))
    )
    expect(bare).toMatchObject({ body: { created: false, api_key: { id: K.bare, team_id: T.data } } })

    const after = await json(await unassignedRoute.GET(req("/x?month=2026-11")))
    expect(after.body).toMatchObject({ total_cost_usd: 42.5, assigned_cost_usd: 32.5, unassigned_cost_usd: 10 })
    expect(after.body.groups.map((g: { key: string }) => g.key)).toEqual(["other", `project:${P.openai}:proj_1`])
  })

  it("rejects an unknown team, an invalid email and an unknown kind", async () => {
    expect((await assignRoute.POST(req("/x", "POST", { kind: "person", email: "a@liatrio.com", team_id: "t-nope" }))).status).toBe(400)
    expect((await assignRoute.POST(req("/x", "POST", { kind: "person", email: "bad", team_id: T.data }))).status).toBe(400)
    expect((await assignRoute.POST(req("/x", "POST", { kind: "project", team_id: T.data }))).status).toBe(400)
    expect(mockDb.writes()).toEqual([])
  })
})
