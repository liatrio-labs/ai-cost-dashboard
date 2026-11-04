/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures */
/**
 * OpenAI key sync (issue #46): in-memory Supabase fake, mocked fetch, no network.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { FakeSupabase } from "./admin/testing/fake-supabase"
import { buildOrgIndex, resolveAttribution } from "./attribution"
import { transform } from "@/lib/collectors/openai"
import { unresolvedReasonText } from "./key-status"
import {
  OpenAIKeySyncError,
  applyOpenAIKeySync,
  keysFromCostRecords,
  listOpenAIKeyData,
  loadOpenAIKeysFromCostRecords,
  parseOpenAIKey,
  syncOpenAIKeys,
  withCostRecordKeys,
  type OpenAIApiKey,
  type OpenAIKeyListing,
} from "./openai-key-sync"
import type { OrgData } from "./types"

const OA = "prov-openai"
const TEAM_OPS = "team-ops"
const TEAM_ML = "team-ml"

const user = (email: string | null, id = `user_${email?.split("@")[0] ?? "x"}`) => ({ type: "user", id, email, name: null })

const key = (id: string, extra: Partial<OpenAIApiKey> = {}): OpenAIApiKey => ({
  id,
  name: id,
  project_id: "proj_ml",
  owner: user("alice@liatrio.com"),
  source: "api",
  ...extra,
})

const keys = (): OpenAIApiKey[] => [
  key("key_alice"),
  // Email casing / spacing from the API is normalized.
  key("key_bob", { owner: user(" Bob@Liatrio.com ") }),
  key("key_stranger", { owner: user("stranger@example.com") }),
  key("key_svc", { owner: { type: "service_account", id: "svc_1", email: null, name: "ci" } }),
  key("key_noemail", { owner: user(null, "user_ghost") }),
  key("key_none", { owner: null }),
  key("key_identity", { owner: user("carol.alt@liatrio.com") }),
]

const listing = (over: Partial<OpenAIKeyListing> = {}): OpenAIKeyListing => ({
  keys: keys(),
  projects: [
    { id: "proj_ml", name: "ML" },
    { id: "proj_empty", name: "Empty" },
  ],
  ...over,
})

function seed() {
  return new FakeSupabase({
    providers: [{ id: OA, name: "openai" }],
    teams: [
      { id: TEAM_OPS, name: "Ops", department_id: null },
      { id: TEAM_ML, name: "ML", department_id: null },
    ],
    people: [
      { id: "p-alice", email: "alice@liatrio.com", display_name: "Alice", team_id: TEAM_OPS, active: true },
      { id: "p-bob", email: "bob@liatrio.com", display_name: "Bob", team_id: null, active: true },
      { id: "p-carol", email: "carol@liatrio.com", display_name: "Carol", team_id: null, active: true },
    ],
    // Carol is known to OpenAI under another address.
    person_identities: [{ id: "pi-1", person_id: "p-carol", provider_id: OA, external_id: "carol.alt@liatrio.com" }],
    org_api_keys: [],
    org_projects: [],
    cost_records: [],
  })
}

const asClient = (db: FakeSupabase) => db as unknown as SupabaseClient
const keyRow = (db: FakeSupabase, ext: string) => db.table("org_api_keys").find((k) => k.external_key_id === ext) as any
const projectRow = (db: FakeSupabase, ext: string) => db.table("org_projects").find((p) => p.external_project_id === ext) as any

function orgOf(db: FakeSupabase): OrgData {
  return {
    departments: [],
    teams: db.table("teams") as any,
    people: db.table("people") as any,
    identities: db.table("person_identities") as any,
    apiKeys: db.table("org_api_keys") as any,
    projects: db.table("org_projects") as any,
  }
}

/** OpenAI cost rows exactly as the collector writes them (transform), with the creator's email in metadata. */
function costRows(): any[] {
  const day1 = Date.UTC(2026, 9, 1) / 1000
  const day2 = Date.UTC(2026, 9, 2) / 1000
  const r = (keyId: string, value: number) => ({ amount: { value, currency: "usd" }, line_item: "gpt-5", project_id: "proj_ml", api_key_id: keyId })
  const costs = [
    { start_time: day1, results: [r("key_alice", 10), r("key_stranger", 4), r("key_deleted", 7)] },
    { start_time: day2, results: [r("key_alice", 5), r("key_bob", 3), r("key_deleted", 1)] },
  ]
  const names = {
    projects: { proj_ml: "ML" },
    apiKeys: {
      key_alice: { name: "alice", owner_email: "alice@liatrio.com" },
      key_bob: { name: "bob", owner_email: "bob@liatrio.com" },
      key_stranger: { name: "stranger", owner_email: "stranger@example.com" },
      // Deleted since: the API no longer lists it, but its rows kept the creator.
      key_deleted: { name: "old notebook", owner_email: "bob@liatrio.com" },
    },
  }
  return transform(costs, [], { userId: "owner", providerId: OA }, names).map((x, i) => ({ id: `cr-${i}`, ...x }))
}

describe("applyOpenAIKeySync", () => {
  test("a key whose creator email matches a person is auto-owned by them, under its project", async () => {
    const db = seed()
    const s = await applyOpenAIKeySync(asClient(db), OA, listing())
    expect(s.status).toBe("success")
    const ml = projectRow(db, "proj_ml")
    expect(ml).toMatchObject({ provider_id: OA, name: "ML" })
    expect(projectRow(db, "proj_empty")).toMatchObject({ name: "Empty" })
    expect(keyRow(db, "key_alice")).toMatchObject({
      provider_id: OA,
      owner_person_id: "p-alice",
      assignment_source: "auto",
      org_project_id: ml.id,
      external_created_by: "user_alice",
      external_created_by_email: "alice@liatrio.com",
      spend_attribution: null,
      team_id: null,
      unresolved_reason: null,
    })
    expect(keyRow(db, "key_alice")).not.toHaveProperty("external_status")
    expect(keyRow(db, "key_bob")).toMatchObject({ owner_person_id: "p-bob", external_created_by_email: "bob@liatrio.com" })
    // Matched through an openai person_identities row.
    expect(keyRow(db, "key_identity")).toMatchObject({ owner_person_id: "p-carol", assignment_source: "auto" })
  })

  test("never creates a person: an email that matches nobody is unassigned with unmatched_creator", async () => {
    const db = seed()
    const s = await applyOpenAIKeySync(asClient(db), OA, listing())
    expect(s.people_created).toBe(0)
    expect(db.table("people")).toHaveLength(3)
    expect(keyRow(db, "key_stranger")).toMatchObject({
      owner_person_id: null,
      external_created_by_email: "stranger@example.com",
      unresolved_reason: "unmatched_creator",
      // Still under its project (auto), so the project's team applies once set.
      assignment_source: "auto",
    })
    expect(unresolvedReasonText("unmatched_creator", "openai")).toBe("creator's email matches no person")
    expect(unresolvedReasonText("unmatched_creator", "anthropic")).toBe("creator has no email to match")
  })

  test("service accounts, users with no email and keys with no owner keep a reason and are counted", async () => {
    const db = seed()
    const s = await applyOpenAIKeySync(asClient(db), OA, listing())
    expect(s.unresolved_creators).toBe(4)
    expect(Object.fromEntries(s.unresolved.map((u) => [u.external_key_id, u.reason]))).toEqual({
      key_stranger: "unmatched_creator",
      key_svc: "service_account",
      key_noemail: "unmatched_creator",
      key_none: "no_creator",
    })
    expect(keyRow(db, "key_svc")).toMatchObject({ owner_person_id: null, external_created_by: "service_account:svc_1", unresolved_reason: "service_account" })
    expect(keyRow(db, "key_none")).toMatchObject({ owner_person_id: null, external_created_by: null, unresolved_reason: "no_creator" })
  })

  test("manual owner wins over the creator default, and a later sync leaves it alone", async () => {
    const db = seed()
    db.table("org_api_keys").push({
      id: "k-man",
      provider_id: OA,
      external_key_id: "key_alice",
      name: "handed to bob",
      owner_person_id: "p-bob",
      team_id: TEAM_ML,
      org_project_id: null,
      assignment_source: "manual",
      unresolved_reason: null,
    } as any)
    // A legacy key with an owner and NULL source is manual too.
    db.table("org_api_keys").push({ id: "k-legacy", provider_id: OA, external_key_id: "key_bob", name: null, owner_person_id: "p-carol", team_id: null, org_project_id: null, assignment_source: null } as any)
    const s = await applyOpenAIKeySync(asClient(db), OA, listing())
    expect(s.manual_kept).toBe(2)
    expect(keyRow(db, "key_alice")).toMatchObject({
      owner_person_id: "p-bob",
      team_id: TEAM_ML,
      org_project_id: null,
      assignment_source: "manual",
      name: "handed to bob",
      // Metadata still refreshes.
      external_created_by_email: "alice@liatrio.com",
    })
    expect(keyRow(db, "key_bob")).toMatchObject({ owner_person_id: "p-carol", assignment_source: null, name: "key_bob" })
    // The manual owner, not the creator, gets the spend.
    const row = costRows().find((r) => r.metadata.attribution.api_key_id === "key_alice")
    expect(resolveAttribution(row, buildOrgIndex(orgOf(db)))).toMatchObject({ person_id: "p-bob", team_id: TEAM_ML })
    const again = await applyOpenAIKeySync(asClient(db), OA, listing())
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 7, manual_kept: 2 })
    expect(keyRow(db, "key_alice").owner_person_id).toBe("p-bob")
  })

  test("an existing auto owner follows the creator; a key that resolves clears its reason", async () => {
    const db = seed()
    db.table("org_api_keys").push({ id: "k1", provider_id: OA, external_key_id: "key_alice", name: "key_alice", owner_person_id: null, team_id: null, org_project_id: null, assignment_source: null, unresolved_reason: "unmatched_creator" } as any)
    const s = await applyOpenAIKeySync(asClient(db), OA, listing())
    expect(s.manual_kept).toBe(0)
    expect(keyRow(db, "key_alice")).toMatchObject({ owner_person_id: "p-alice", assignment_source: "auto", unresolved_reason: null })
  })

  test("a second run is all unchanged", async () => {
    const db = seed()
    const first = await applyOpenAIKeySync(asClient(db), OA, listing())
    expect(first.created).toBe(7)
    const writes = db.writes.length
    const second = await applyOpenAIKeySync(asClient(db), OA, listing())
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 7, projects_created: 0 })
    expect(db.writes.length).toBe(writes)
  })

  test("only touches openai rows", async () => {
    const db = seed()
    db.table("org_api_keys").push({ id: "other", provider_id: "prov-anthropic", external_key_id: "key_alice", name: "x", owner_person_id: null, team_id: null, org_project_id: null, assignment_source: null } as any)
    await applyOpenAIKeySync(asClient(db), OA, listing())
    expect(db.table("org_api_keys").find((k) => k.id === "other")).toMatchObject({ owner_person_id: null, name: "x" })
  })

  test("before migration 017 the sync reads and writes the 015 columns only", async () => {
    const db = seed()
    const client = {
      from(table: string) {
        const q = (db as any).from(table)
        if (table !== "org_api_keys") return q
        const select = q.select.bind(q)
        q.select = (cols: string) =>
          /external_status|unresolved_reason/.test(cols)
            ? { eq: () => ({ in: async () => ({ data: null, error: { code: "42703", message: 'column "unresolved_reason" does not exist' } }) }) }
            : select(cols)
        const insert = q.insert.bind(q)
        q.insert = (row: any) => {
          if ("external_status" in row || "unresolved_reason" in row) throw new Error("017 column written before 017")
          return insert(row)
        }
        return q
      },
    }
    const s = await applyOpenAIKeySync(client as unknown as SupabaseClient, OA, listing())
    expect(s.created).toBe(7)
    expect(s.unresolved_creators).toBe(4)
    expect(keyRow(db, "key_alice")).toMatchObject({ owner_person_id: "p-alice" })
    expect(keyRow(db, "key_svc")).not.toHaveProperty("unresolved_reason")
  })
})

describe("OpenAI cost rows attribute to the key creator (fixture)", () => {
  test("rows on a key whose owner email matches a person go to that person; totals are unchanged", async () => {
    const db = seed()
    const rows = costRows()
    db.tables.cost_records = rows

    const byPerson = () => {
      const index = buildOrgIndex(orgOf(db))
      const out: Record<string, Record<string, number>> = {}
      for (const r of rows) {
        const day = r.timestamp.slice(0, 10)
        const who = resolveAttribution(r, index).person_id ?? "unassigned"
        out[day] ??= {}
        out[day][who] = (out[day][who] ?? 0) + r.cost_usd
      }
      return out
    }
    const dayTotals = (m: Record<string, Record<string, number>>) =>
      Object.fromEntries(Object.entries(m).map(([d, v]) => [d, Object.values(v).reduce((a, b) => a + b, 0)]))

    const before = byPerson()
    expect(before).toEqual({ "2026-10-01": { unassigned: 21 }, "2026-10-02": { unassigned: 9 } })

    // The API lists the live keys; key_deleted only exists on cost rows.
    const live = listing({
      keys: [key("key_alice"), key("key_bob", { owner: user("bob@liatrio.com") }), key("key_stranger", { owner: user("stranger@example.com") })],
    })
    const s = await applyOpenAIKeySync(asClient(db), OA, await withCostRecordKeys(asClient(db), OA, live))
    expect(s).toMatchObject({ keys_listed: 4, keys_from_cost_records: 1, people_created: 0 })
    expect(keyRow(db, "key_deleted")).toMatchObject({ owner_person_id: "p-bob", name: "old notebook", external_created_by_email: "bob@liatrio.com", assignment_source: "auto" })

    const after = byPerson()
    expect(after).toEqual({
      "2026-10-01": { "p-alice": 10, unassigned: 4, "p-bob": 7 },
      "2026-10-02": { "p-alice": 5, "p-bob": 4 },
    })
    // attributed + Unassigned = org total, per day, before and after.
    expect(dayTotals(after)).toEqual(dayTotals(before))
    expect(resolveAttribution(rows[0], buildOrgIndex(orgOf(db)))).toMatchObject({ person_id: "p-alice", team_id: TEAM_OPS, project_id: "proj_ml" })
  })

  test("the person who actually used the key beats the auto creator owner", async () => {
    const db = seed()
    await applyOpenAIKeySync(asClient(db), OA, listing())
    const row = { provider_id: OA, metadata: { attribution: { api_key_id: "key_alice", project_id: "proj_ml", person_email: "bob@liatrio.com", granularity: "person" } } }
    expect(resolveAttribution(row, buildOrgIndex(orgOf(db)))).toMatchObject({ person_id: "p-bob" })
  })

  test("an unowned key falls back to its project's team, then Unassigned", async () => {
    const db = seed()
    await applyOpenAIKeySync(asClient(db), OA, listing())
    const row = { provider_id: OA, metadata: { attribution: { api_key_id: "key_svc", project_id: "proj_ml", granularity: "api_key" } } }
    expect(resolveAttribution(row, buildOrgIndex(orgOf(db)))).toMatchObject({ person_id: null, team_id: null })
    projectRow(db, "proj_ml").team_id = TEAM_ML
    expect(resolveAttribution(row, buildOrgIndex(orgOf(db)))).toMatchObject({ person_id: null, team_id: TEAM_ML })
  })

  test("a cost-row key with no recorded email keeps an existing owner and email", async () => {
    const db = seed()
    db.table("org_api_keys").push({ id: "k1", provider_id: OA, external_key_id: "key_gone", name: "gone", owner_person_id: "p-alice", team_id: null, org_project_id: null, external_created_by: "user_alice", external_created_by_email: "alice@liatrio.com", spend_attribution: null, assignment_source: "auto", unresolved_reason: null } as any)
    const fromRows = keysFromCostRecords([{ metadata: { api_key_owner_email: null, attribution: { api_key_id: "key_gone", api_key_name: "gone" } } }])
    const s = await applyOpenAIKeySync(asClient(db), OA, { keys: fromRows, projects: null })
    expect(s.unresolved_creators).toBe(0)
    expect(keyRow(db, "key_gone")).toMatchObject({ owner_person_id: "p-alice", external_created_by_email: "alice@liatrio.com", assignment_source: "auto" })
  })

  test("loadOpenAIKeysFromCostRecords reads key, name, email and project from this provider's rows", async () => {
    const db = seed()
    db.tables.cost_records = [...costRows(), { id: "cr-x", provider_id: "prov-other", metadata: { attribution: { api_key_id: "key_foreign" } } }]
    const found = await loadOpenAIKeysFromCostRecords(asClient(db), OA)
    expect(found?.map((k) => [k.id, k.owner?.email ?? null, k.project_id, k.name]).sort()).toEqual([
      ["key_alice", "alice@liatrio.com", "proj_ml", "alice"],
      ["key_bob", "bob@liatrio.com", "proj_ml", "bob"],
      ["key_deleted", "bob@liatrio.com", "proj_ml", "old notebook"],
      ["key_stranger", "stranger@example.com", "proj_ml", "stranger"],
    ])
  })

  test("a failed cost-row scan is best-effort", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const client = { from: () => ({ select: () => ({ eq: () => ({ not: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: "boom" } }) }) }) }) }) }) }
    try {
      const l = await withCostRecordKeys(client as unknown as SupabaseClient, OA, listing())
      expect(l.cost_records_unavailable).toBe(true)
      expect(l.keys).toHaveLength(7)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("parseOpenAIKey", () => {
  test("user, service account and missing owners", () => {
    expect(parseOpenAIKey({ id: "k", name: "n", owner: { type: "user", user: { id: "u1", email: "A@B.com", name: "A" } } }, "p")).toEqual({
      id: "k",
      name: "n",
      project_id: "p",
      owner: { type: "user", id: "u1", email: "a@b.com", name: "A" },
      source: "api",
    })
    expect(parseOpenAIKey({ id: "k", owner: { type: "service_account", service_account: { id: "sa", name: "bot" } } }, "p")?.owner).toEqual({
      type: "service_account",
      id: "sa",
      email: null,
      name: "bot",
    })
    expect(parseOpenAIKey({ id: "k" }, "p")?.owner).toBeNull()
    expect(parseOpenAIKey({ name: "no id" }, "p")).toBeNull()
  })
})

describe("listOpenAIKeyData / syncOpenAIKeys (mocked fetch)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

  test("lists projects (archived included, paged) and every project's keys", async () => {
    const calls: string[] = []
    global.fetch = jest.fn(async (url: any, init: any) => {
      const u = new URL(String(url))
      calls.push(`${u.pathname}?${u.searchParams}`)
      expect(init.headers.Authorization).toBe("Bearer test-admin-key")
      expect(init.headers["OpenAI-Organization"]).toBe("org-test")
      if (u.pathname === "/v1/organization/projects") {
        if (!u.searchParams.get("after")) return res({ data: [{ id: "proj_a", name: "A" }], has_more: true, last_id: "proj_a" })
        return res({ data: [{ id: "proj_b", name: "B" }], has_more: false, last_id: "proj_b" })
      }
      if (u.pathname === "/v1/organization/projects/proj_a/api_keys")
        return res({ data: [{ id: "key_1", name: "one", owner: { type: "user", user: { id: "u1", email: "alice@liatrio.com" } } }], has_more: false })
      if (u.pathname === "/v1/organization/projects/proj_b/api_keys") return res({ data: [], has_more: false })
      throw new Error(`unexpected ${u}`)
    }) as any
    const l = await listOpenAIKeyData("test-admin-key", "org-test")
    expect(calls.slice(0, 2)).toEqual([
      "/v1/organization/projects?include_archived=true&limit=100",
      "/v1/organization/projects?include_archived=true&limit=100&after=proj_a",
    ])
    expect(l.projects).toEqual([
      { id: "proj_a", name: "A" },
      { id: "proj_b", name: "B" },
    ])
    expect(l.keys.map((k) => [k.id, k.project_id, k.owner?.email])).toEqual([["key_1", "proj_a", "alice@liatrio.com"]])
  })

  test("a list failure throws and writes nothing", async () => {
    const db = seed()
    global.fetch = jest.fn(async () => res({ error: { message: "nope" } }, 403)) as any
    await expect(syncOpenAIKeys(asClient(db), { adminKey: "test-admin-key", providerId: OA })).rejects.toBeInstanceOf(OpenAIKeySyncError)
    expect(db.writes).toHaveLength(0)
  })

  test("a per-project key list failure is strict too", async () => {
    const db = seed()
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname === "/v1/organization/projects") return res({ data: [{ id: "proj_a" }], has_more: false })
      return res({}, 500)
    }) as any
    await expect(syncOpenAIKeys(asClient(db), { adminKey: "test-admin-key", providerId: OA })).rejects.toThrow(/HTTP 500/)
    expect(db.writes).toHaveLength(0)
  })

  test("post-collect: records in hand supply deleted keys without scanning cost_records", async () => {
    const db = seed()
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname === "/v1/organization/projects") return res({ data: [{ id: "proj_ml", name: "ML" }], has_more: false })
      return res({ data: [{ id: "key_alice", name: "alice", owner: { type: "user", user: { id: "u", email: "alice@liatrio.com" } } }], has_more: false })
    }) as any
    const s = await syncOpenAIKeys(asClient(db), { adminKey: "test-admin-key", providerId: OA, records: costRows() })
    expect(s).toMatchObject({ keys_listed: 4, keys_from_cost_records: 3, created: 4 })
    expect(keyRow(db, "key_deleted")).toMatchObject({ owner_person_id: "p-bob" })
  })
})
