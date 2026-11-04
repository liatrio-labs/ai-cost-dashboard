/**
 * @jest-environment node
 *
 * Route tests for the duplicate-person merge tool (issue #51):
 * GET /api/admin/org/people/duplicates and POST /api/admin/org/people/merge.
 * merge_people() is SQL (migration 021, checked against a real Postgres in
 * scripts/migration-tests/assertions_021.sql); here the fake client gets a
 * stand-in with the same contract so the route's preview, idempotency and
 * "021 not applied" handling can be tested without a database.
 */

import { NextRequest } from "next/server"
import type { FakeSupabase } from "./testing/fake-supabase"
import { seedDb } from "./testing/seed"
import { K, P, PE, T } from "../test-fixtures"

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

import * as duplicates from "@/app/api/admin/org/people/duplicates/route"
import * as merge from "@/app/api/admin/org/people/merge/route"
import { MIGRATION_021_MESSAGE } from "../person-merge"

const ADMIN = { id: "u-admin", email: "admin@example.com" }
const DUP = "p-dave-2"

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
async function call(handler: unknown, method: string, body?: unknown) {
  const req = new NextRequest(new URL("/api/admin/org/people/merge", "http://localhost"), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  })
  const res = await (handler as Handler)(req, { params: Promise.resolve({}) })
  return { status: res.status, body: await res.json() }
}
const rows = (t: string) => mockState.db.table(t)

type Row = Record<string, unknown>
/** In-memory merge_people() with the SQL function's contract (see 021_person_merge.sql). */
function fakeMergePeople(db: FakeSupabase) {
  return (args: Record<string, unknown> | undefined) => {
    const pid = args?.p_primary as string
    const sid = args?.p_secondary as string
    const people = db.table("people")
    const sec = people.find((p) => p.id === sid)
    if (!sec) {
      const log = db.table("person_merges").find((m) => m.secondary_person_id === sid)
      if (log && log.primary_person_id === pid) {
        return { data: { ...(log.moved as Row), already_merged: true, primary_id: pid, secondary_id: sid, secondary_email: log.secondary_email, merged_at: log.merged_at }, error: null }
      }
      return { data: null, error: { code: "P0001", message: log ? `merge_people: ${log.secondary_email} was already merged into another person (${log.primary_person_id})` : `merge_people: secondary person ${sid} not found` } }
    }
    const pri = people.find((p) => p.id === pid)
    if (!pri) return { data: null, error: { code: "P0001", message: `merge_people: primary person ${pid} not found` } }
    const ids = db.table("person_identities").filter((i) => i.person_id === sid)
    ids.forEach((i) => (i.person_id = pid))
    const keys = db.table("org_api_keys").filter((k) => k.owner_person_id === sid)
    keys.forEach((k) => (k.owner_person_id = pid))
    const seats = db.table("cost_records").filter((r) => {
      const m = r.metadata as Row | null
      const a = m?.attribution as Row | undefined
      return m?.entry_type === "monthly_seats" && typeof a?.person_email === "string" && a.person_email.trim().toLowerCase() === sec.email
    })
    seats.forEach((r) => (((r.metadata as Row).attribution as Row).person_email = pri.email))
    let aliases = 0
    for (const pv of db.table("providers")) {
      if (db.table("person_identities").some((i) => i.provider_id === pv.id && i.external_id === sec.email)) continue
      db.table("person_identities").push({ id: db.nextId("person_identities"), person_id: pid, provider_id: pv.id, external_id: sec.email })
      aliases += 1
    }
    const team_adopted = !pri.team_id && !!sec.team_id
    const display_name_adopted = !String(pri.display_name ?? "").trim() && !!String(sec.display_name ?? "").trim()
    pri.team_id ??= sec.team_id
    if (display_name_adopted) pri.display_name = sec.display_name
    pri.active = pri.active !== false || sec.active !== false
    people.splice(people.indexOf(sec), 1)
    const moved = { identities_moved: ids.length, keys_moved: keys.length, seat_rows_moved: seats.length, aliases_added: aliases, team_adopted, display_name_adopted }
    db.table("person_merges").push({ primary_person_id: pid, secondary_person_id: sid, secondary_email: sec.email, moved, merged_at: "2026-11-04T00:00:00Z" })
    return { data: { ...moved, already_merged: false, primary_id: pid, secondary_id: sid, secondary_email: sec.email }, error: null }
  }
}

const savedEnv = { ...process.env }
beforeAll(() => {
  process.env.ADMIN_EMAILS = ADMIN.email
})
afterAll(() => {
  process.env = savedEnv
})
beforeEach(() => {
  mockState.db = seedDb()
  mockState.refreshes = 0
  mockAuth.user = ADMIN
  // A duplicate Dave on another domain: no team, owns key_bare, has an
  // identity, and holds two Claude Ultra seat rows.
  rows("people").push({ id: DUP, email: "dave@liatrio.io", display_name: "Dave", team_id: null, active: true })
  rows("person_identities").push({ id: "ident-dup", person_id: DUP, provider_id: P.anthropic, external_id: "user_dave2" })
  rows("org_api_keys").find((k) => k.id === K.bare)!.owner_person_id = DUP
  for (const [id, email, cost] of [["seat-1", "dave@liatrio.io", 200], ["seat-2", "Dave@Liatrio.io", 200], ["seat-3", "alice@liatrio.com", 200]] as const) {
    rows("cost_records").push({
      id, provider_id: P.anthropic, timestamp: "2026-11-01T00:00:00Z", cost_usd: cost, collection_method: "manual_entry",
      metadata: { entry_type: "monthly_seats", month: "2026-11", attribution: { granularity: "person", person_email: email } },
    })
  }
  rows("person_merges") // exists (021 applied) unless a test marks it missing
  mockState.db.rpcHandlers.merge_people = fakeMergePeople(mockState.db)
})

describe("GET /people/duplicates", () => {
  it("lists likely duplicates with a suggested primary and reports 021 applied", async () => {
    const res = await call(duplicates.GET, "GET")
    expect(res.status).toBe(200)
    expect(res.body.migration021).toBe(true)
    expect(res.body.message).toBeNull()
    expect(res.body.groups).toHaveLength(1)
    const g = res.body.groups[0]
    expect(g.members.map((m: { id: string }) => m.id)).toEqual([PE.dave, DUP])
    expect(g.suggestedPrimaryId).toBe(PE.dave)
    expect(g.reasons).toEqual([{ kind: "name", value: "dave" }, { kind: "email_local_part", value: "dave" }])
  })

  it("without 021: still lists duplicates, says merging is disabled, no 500", async () => {
    mockState.db.missingTables.add("person_merges")
    const res = await call(duplicates.GET, "GET")
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ migration021: false, message: MIGRATION_021_MESSAGE })
    expect(res.body.groups).toHaveLength(1)
  })
})

describe("POST /people/merge", () => {
  it("preview shows the moved counts and changes nothing", async () => {
    const before = JSON.stringify(mockState.db.tables)
    const res = await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP, preview: true })
    expect(res.status).toBe(200)
    expect(res.body.migration021).toBe(true)
    expect(res.body.preview).toMatchObject({
      identities_moved: 1,
      keys_moved: 1,
      seat_rows_moved: 2,
      aliases_added: 3,
      team_adopted: false,
      display_name_adopted: false,
      result: { email: "dave@liatrio.com", team_id: T.data, active: true },
    })
    expect(JSON.stringify(mockState.db.tables)).toBe(before)
    expect(mockState.db.rpcCalls).toEqual([])
  })

  it("merge moves what the preview said, refreshes the rollups, and is idempotent", async () => {
    const preview = (await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP, preview: true })).body.preview
    const res = await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP })
    expect(res.status).toBe(200)
    expect(mockState.db.rpcLog).toEqual([{ name: "merge_people", args: { p_primary: PE.dave, p_secondary: DUP, p_merged_by: ADMIN.email } }])
    const counts = ["identities_moved", "keys_moved", "seat_rows_moved", "aliases_added", "team_adopted", "display_name_adopted"]
    for (const c of counts) expect(res.body.result[c]).toBe(preview[c])
    expect(res.body.result.already_merged).toBe(false)
    expect(mockState.refreshes).toBe(1)
    expect(rows("people").some((p) => p.id === DUP)).toBe(false)
    expect(rows("org_api_keys").find((k) => k.id === K.bare)!.owner_person_id).toBe(PE.dave)
    expect(rows("person_identities").filter((i) => i.person_id === DUP)).toEqual([])

    // Again: same answer, already_merged, nothing written, no refresh, no rpc.
    const snapshot = JSON.stringify(mockState.db.tables)
    const again = await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP })
    expect(again.status).toBe(200)
    expect(again.body.result.already_merged).toBe(true)
    for (const c of counts) expect(again.body.result[c]).toBe(res.body.result[c])
    expect(JSON.stringify(mockState.db.tables)).toBe(snapshot)
    expect(mockState.refreshes).toBe(1)
    expect(mockState.db.rpcCalls).toEqual(["merge_people"])

    // A preview of the merged pair says so too.
    const p = await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP, preview: true })
    expect(p.body.result.already_merged).toBe(true)
    // Into someone else: refused.
    expect((await call(merge.POST, "POST", { primary_id: PE.alice, secondary_id: DUP })).status).toBe(409)
  })

  it("without 021: preview works, merge is refused with a clear 409, nothing written", async () => {
    mockState.db.missingTables.add("person_merges")
    const p = await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP, preview: true })
    expect(p.status).toBe(200)
    expect(p.body).toMatchObject({ migration021: false, message: MIGRATION_021_MESSAGE, preview: { keys_moved: 1 } })
    const before = JSON.stringify(mockState.db.tables)
    const res = await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP })
    expect(res).toEqual({ status: 409, body: { error: MIGRATION_021_MESSAGE, migration021: false } })
    expect(JSON.stringify(mockState.db.tables)).toBe(before)
    expect(mockState.db.rpcCalls).toEqual([])
    expect(mockState.refreshes).toBe(0)
  })

  it("table present but function missing (partial 021): 409 not 500", async () => {
    mockState.db.rpcHandlers.merge_people = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.merge_people(p_merged_by, p_primary, p_secondary) in the schema cache" } })
    const res = await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP })
    expect(res).toEqual({ status: 409, body: { error: MIGRATION_021_MESSAGE, migration021: false } })
  })

  it("validation: same id twice 400, unknown people 404, junk body 400", async () => {
    expect((await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: PE.dave })).status).toBe(400)
    expect((await call(merge.POST, "POST", { primary_id: "nope", secondary_id: DUP })).status).toBe(404)
    expect((await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: "nope" })).status).toBe(404)
    expect((await call(merge.POST, "POST", { primary_id: PE.dave })).status).toBe(400)
    expect((await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP, extra: 1 })).status).toBe(400)
    expect(mockState.db.rpcCalls).toEqual([])
  })

  it("admin only", async () => {
    mockAuth.user = null
    expect((await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP })).status).toBe(401)
    expect((await call(duplicates.GET, "GET")).status).toBe(401)
    mockAuth.user = { id: "u-out", email: "someone@elsewhere.test" }
    expect((await call(merge.POST, "POST", { primary_id: PE.dave, secondary_id: DUP })).status).toBe(403)
    expect(mockState.db.rpcCalls).toEqual([])
  })
})
