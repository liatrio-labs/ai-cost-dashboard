/**
 * @jest-environment node
 *
 * Admin access and the editable admin list (issue #71): isAdminEmail (env
 * allowlist, explicit ADMIN_DOMAINS, admin_users rows, no liatrio.com
 * default, migration 023 missing) and /api/admin/admins. The real
 * requireAdmin runs against a mocked Supabase auth client; the service-role
 * client is the in-memory fake. No network, no database.
 */

import { NextRequest } from "next/server"
import { FakeSupabase } from "@/lib/org/admin/testing/fake-supabase"

const mockAuth = { user: null as null | { id: string; email: string } }
const mockState = { db: null as unknown as FakeSupabase, throwOnCreate: false }

jest.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}))
jest.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: mockAuth.user }, error: null }) },
  }),
}))
jest.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (mockState.throwOnCreate) throw new Error("Supabase service credentials not configured")
    return mockState.db
  },
  refreshDailyAggregates: async () => undefined,
}))

import * as admins from "./route"
import * as orgRoot from "@/app/api/admin/org/route"
import * as settings from "@/app/api/admin/settings/route"
import * as recurring from "@/app/api/admin/recurring-costs/route"
import { getAdminDomains, isAdminEmail, isEnvAdminEmail } from "@/lib/db"
import { invalidateAdminUsersCache } from "@/lib/admin-users"

const OWNER = { id: "u-owner", email: "owner@liatrio.com" }
const TABLE_ADMIN = { id: "u-table", email: "table.admin@liatrio.com" }
const COLLEAGUE = { id: "u-colleague", email: "colleague@liatrio.com" }

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

async function call(handler: unknown, method: string, path: string, body?: unknown) {
  const req = new NextRequest(new URL(path, "http://localhost"), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  })
  const res = await (handler as Handler)(req, { params: Promise.resolve({}) })
  return { status: res.status, body: await res.json() }
}
const list = () => call(admins.GET, "GET", "/api/admin/admins")
const add = (email: unknown) => call(admins.POST, "POST", "/api/admin/admins", { email })
const remove = (email: string, confirm = true) =>
  call(admins.DELETE, "DELETE", `/api/admin/admins?email=${encodeURIComponent(email)}${confirm ? "&confirm=true" : ""}`)

function seed(rows: object[] = [{ email: TABLE_ADMIN.email, added_by: OWNER.email, added_at: "2026-10-01T00:00:00Z" }]) {
  const withIds = rows.map((r, i) => ({ id: `admin-${i}`, ...r }))
  return new FakeSupabase({ admin_users: withIds }, { admin_users: { unique: [{ columns: ["email"] }] } })
}
const emails = () => mockState.db.table("admin_users").map((r) => r.email)

const savedEnv = { ...process.env }
beforeEach(() => {
  process.env = { ...savedEnv, ADMIN_EMAILS: OWNER.email }
  delete process.env.ADMIN_DOMAINS
  delete process.env.DASHBOARD_OWNER_EMAIL
  mockState.db = seed()
  mockState.throwOnCreate = false
  mockAuth.user = OWNER
  invalidateAdminUsersCache()
})
afterAll(() => {
  process.env = savedEnv
})

describe("isAdminEmail", () => {
  it("does not make a @liatrio.com email an admin by default", async () => {
    expect(getAdminDomains()).toEqual([])
    expect(isEnvAdminEmail(COLLEAGUE.email)).toBe(false)
    expect(await isAdminEmail(COLLEAGUE.email)).toBe(false)
  })

  it("still honors ADMIN_DOMAINS when set explicitly", async () => {
    process.env.ADMIN_DOMAINS = "@Liatrio.com, example.test"
    expect(await isAdminEmail(COLLEAGUE.email)).toBe(true)
    expect(await isAdminEmail("x@example.test")).toBe(true)
    expect(await isAdminEmail("x@elsewhere.test")).toBe(false)
  })

  it("env allowlist admins are always admin, case-insensitively, even with no table", async () => {
    expect(await isAdminEmail("Owner@Liatrio.com")).toBe(true)
    mockState.db.missingTables.add("admin_users")
    invalidateAdminUsersCache()
    expect(await isAdminEmail(OWNER.email)).toBe(true)
    mockState.throwOnCreate = true
    invalidateAdminUsersCache()
    expect(await isAdminEmail(OWNER.email)).toBe(true)
  })

  it("falls back to DASHBOARD_OWNER_EMAIL, then robert@liatrio.com", async () => {
    delete process.env.ADMIN_EMAILS
    process.env.DASHBOARD_OWNER_EMAIL = "boss@liatrio.com"
    expect(isEnvAdminEmail("boss@liatrio.com")).toBe(true)
    delete process.env.DASHBOARD_OWNER_EMAIL
    expect(isEnvAdminEmail("robert@liatrio.com")).toBe(true)
  })

  it("a row in admin_users makes an email admin, case-insensitively", async () => {
    expect(await isAdminEmail(TABLE_ADMIN.email)).toBe(true)
    expect(await isAdminEmail("Table.Admin@LIATRIO.com")).toBe(true)
    expect(await isAdminEmail(null)).toBe(false)
  })

  it("missing admin_users table (023 not applied) means env-only admins, no errors", async () => {
    mockState.db.missingTables.add("admin_users")
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined)
    expect(await isAdminEmail(TABLE_ADMIN.email)).toBe(false)
    expect(await isAdminEmail(COLLEAGUE.email)).toBe(false)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it("unreadable admin_users (no service credentials) means env-only admins, no throw", async () => {
    mockState.throwOnCreate = true
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined)
    await expect(isAdminEmail(TABLE_ADMIN.email)).resolves.toBe(false)
    errors.mockRestore()
  })
})

describe("admin gate on admin APIs", () => {
  it("a @liatrio.com user who is not in the allowlist or table gets 403", async () => {
    mockAuth.user = COLLEAGUE
    expect((await list()).status).toBe(403)
    expect((await add("new@liatrio.com")).status).toBe(403)
    expect((await remove(TABLE_ADMIN.email)).status).toBe(403)
    expect((await call(orgRoot.GET, "GET", "/api/admin/org")).status).toBe(403)
    expect((await call(() => settings.GET(), "GET", "/api/admin/settings")).status).toBe(403)
    expect((await call(() => recurring.GET(), "GET", "/api/admin/recurring-costs")).status).toBe(403)
    expect(mockState.db.writes).toEqual([])
  })

  it("signed out gets 401 on the admins API", async () => {
    mockAuth.user = null
    expect((await list()).status).toBe(401)
    expect((await add("new@liatrio.com")).status).toBe(401)
    expect((await remove(TABLE_ADMIN.email)).status).toBe(401)
  })

  it("a table admin passes the gate", async () => {
    mockAuth.user = TABLE_ADMIN
    expect((await list()).status).toBe(200)
  })

  it("a table admin loses access once removed (cache invalidated on remove)", async () => {
    mockAuth.user = COLLEAGUE
    expect((await list()).status).toBe(403)
    mockAuth.user = OWNER
    expect((await add(COLLEAGUE.email)).status).toBe(201)
    mockAuth.user = COLLEAGUE
    expect((await list()).status).toBe(200)
    mockAuth.user = OWNER
    expect((await remove(COLLEAGUE.email)).status).toBe(200)
    mockAuth.user = COLLEAGUE
    expect((await list()).status).toBe(403)
  })
})

describe("GET /api/admin/admins", () => {
  it("lists env admins and table admins with who added them", async () => {
    const { status, body } = await list()
    expect(status).toBe(200)
    expect(body).toEqual({
      me: OWNER.email,
      env_admins: [OWNER.email],
      env_domains: [],
      admins: [{ email: TABLE_ADMIN.email, added_by: OWNER.email, added_at: "2026-10-01T00:00:00Z" }],
      migration_applied: true,
    })
  })

  it("reports migration 023 not applied instead of failing", async () => {
    mockState.db.missingTables.add("admin_users")
    const { status, body } = await list()
    expect(status).toBe(200)
    expect(body.migration_applied).toBe(false)
    expect(body.admins).toEqual([])
    expect(body.env_admins).toEqual([OWNER.email])
    expect(body.notice).toMatch(/migration 023 not applied/i)
  })
})

describe("POST /api/admin/admins", () => {
  it("adds a lowercased @liatrio.com address with added_by", async () => {
    const { status, body } = await add("  New.Person@Liatrio.COM ")
    expect(status).toBe(201)
    const row = mockState.db.table("admin_users").find((r) => r.email === "new.person@liatrio.com")
    expect(row).toMatchObject({ added_by: OWNER.email })
    expect(body.admins.map((a: { email: string }) => a.email)).toContain("new.person@liatrio.com")
    expect(await isAdminEmail("new.person@liatrio.com")).toBe(true)
  })

  it.each(["someone@gmail.com", "x@liatrio.com.evil.test", "x@sub.liatrio.com", "liatrio.com", "a b@liatrio.com", "", 42])(
    "rejects %p",
    async (email) => {
      const { status } = await add(email)
      expect(status).toBe(400)
      expect(emails()).toEqual([TABLE_ADMIN.email])
    }
  )

  it("rejects duplicates and env admins with 409", async () => {
    expect((await add("TABLE.ADMIN@liatrio.com")).status).toBe(409)
    expect((await add(OWNER.email)).status).toBe(409)
    expect(emails()).toEqual([TABLE_ADMIN.email])
  })

  it("answers 409 migration_023_not_applied when the table is missing", async () => {
    mockState.db.missingTables.add("admin_users")
    const { status, body } = await add("new@liatrio.com")
    expect(status).toBe(409)
    expect(body.code).toBe("migration_023_not_applied")
  })
})

describe("DELETE /api/admin/admins", () => {
  it("removes a table admin with confirm", async () => {
    const { status, body } = await remove(TABLE_ADMIN.email)
    expect(status).toBe(200)
    expect(body.admins).toEqual([])
    expect(emails()).toEqual([])
    expect(await isAdminEmail(TABLE_ADMIN.email)).toBe(false)
  })

  it("requires confirm", async () => {
    expect((await remove(TABLE_ADMIN.email, false)).status).toBe(400)
    expect(emails()).toEqual([TABLE_ADMIN.email])
  })

  it("blocks self-removal", async () => {
    mockAuth.user = TABLE_ADMIN
    const { status, body } = await remove("Table.Admin@liatrio.com")
    expect(status).toBe(400)
    expect(body.error).toMatch(/yourself/)
    expect(emails()).toEqual([TABLE_ADMIN.email])
  })

  it("blocks removing an env admin, even when they also have a table row", async () => {
    mockState.db = seed([{ email: OWNER.email, added_by: null, added_at: "2026-10-01T00:00:00Z" }])
    mockAuth.user = TABLE_ADMIN
    mockState.db.table("admin_users").push({ id: "admin-x", email: TABLE_ADMIN.email, added_by: OWNER.email, added_at: "2026-10-02T00:00:00Z" })
    const { status, body } = await remove(OWNER.email)
    expect(status).toBe(400)
    expect(body.error).toMatch(/environment/)
    expect(emails()).toContain(OWNER.email)
  })

  it("404s for an address not in the list", async () => {
    expect((await remove("nobody@liatrio.com")).status).toBe(404)
  })

  it("answers 409 migration_023_not_applied when the table is missing", async () => {
    mockState.db.missingTables.add("admin_users")
    const { status, body } = await remove(TABLE_ADMIN.email)
    expect(status).toBe(409)
    expect(body.code).toBe("migration_023_not_applied")
  })
})
