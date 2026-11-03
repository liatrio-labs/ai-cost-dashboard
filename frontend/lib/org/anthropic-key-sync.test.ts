/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures */
/**
 * Anthropic key sync (issue #32): in-memory Supabase fake, mocked fetch, no network.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { FakeSupabase } from "./admin/testing/fake-supabase"
import { buildOrgIndex, resolveAttribution } from "./attribution"
import {
  AnthropicKeySyncError,
  DEFAULT_WORKSPACE_PROJECT_ID,
  applyAnthropicKeySync,
  listAnthropicKeyData,
  resolveCreator,
  syncAnthropicKeys,
  type AnthropicApiKey,
  type AnthropicKeyListing,
  type AnthropicUser,
} from "./anthropic-key-sync"
import type { OrgData } from "./types"

const AN = "prov-anthropic"
const TEAM_RES = "team-research"
const TEAM_OPS = "team-ops"

const key = (id: string, extra: Partial<AnthropicApiKey> = {}): AnthropicApiKey => ({
  id,
  name: id,
  status: "active",
  workspace_id: "wrkspc_research",
  created_by: { id: "user_alice", type: "user" },
  principal: null,
  ...extra,
})

const users = (): Map<string, AnthropicUser> =>
  new Map([
    ["user_alice", { email: "alice@liatrio.com", name: "Alice" }],
    ["user_new", { email: "new.dev@liatrio.com", name: "New Dev" }],
    ["user_bob", { email: "bob@liatrio.com", name: "Bob" }],
    ["user_noemail", { email: null, name: "No Email" }],
  ])

const keys = (): AnthropicApiKey[] => [
  key("k_alice"),
  key("k_new", { created_by: { id: "user_new", type: "user" } }),
  // principal (bob) beats created_by (alice)
  key("k_principal", { principal: { user_id: "user_bob", type: "user" } }),
  key("k_svc", { created_by: { id: "svcacct_1", type: "service_account" } }),
  key("k_deleted", { created_by: { id: "user_gone", type: "user" } }),
  key("k_null", { created_by: null }),
  key("k_unmatched", { created_by: { id: "user_noemail", type: "user" } }),
  key("k_archived", { status: "archived", workspace_id: "wrkspc_old" }),
  key("k_default", { workspace_id: null }),
]

const listing = (over: Partial<AnthropicKeyListing> = {}): AnthropicKeyListing => ({
  keys: keys(),
  users: users(),
  workspaces: [
    { id: "wrkspc_research", name: "Research", is_default: false },
    { id: "wrkspc_old", name: "Old (archived)", is_default: false },
    { id: null, name: "Default", is_default: true },
  ],
  ...over,
})

function seed() {
  return new FakeSupabase({
    providers: [{ id: AN, name: "anthropic" }],
    teams: [
      { id: TEAM_RES, name: "Research", department_id: null },
      { id: TEAM_OPS, name: "Ops", department_id: null },
    ],
    people: [
      { id: "p-alice", email: "alice@liatrio.com", display_name: "Alice", team_id: TEAM_OPS, active: true },
      { id: "p-bob", email: "bob@liatrio.com", display_name: "Bob", team_id: null, active: true },
    ],
    person_identities: [],
    org_api_keys: [],
    org_projects: [],
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
    identities: [],
    apiKeys: db.table("org_api_keys") as any,
    projects: db.table("org_projects") as any,
  }
}

/** A cost row as the Anthropic collector writes it (project_id = workspace_id). */
const anRow = (keyId: string, workspaceId: string | null, actor?: { email: string; id: string }) => ({
  provider_id: AN,
  metadata: {
    attribution: {
      api_key_id: keyId,
      ...(workspaceId ? { workspace_id: workspaceId, project_id: workspaceId } : {}),
      ...(actor ? { person_email: actor.email, person_external_id: actor.id } : {}),
      granularity: actor ? "person" : "api_key",
    },
  },
})

describe("applyAnthropicKeySync", () => {
  test("a user-created key is owned by its creator (matched by email), under its workspace project", async () => {
    const db = seed()
    const s = await applyAnthropicKeySync(asClient(db), AN, listing())
    expect(s.status).toBe("success")
    const research = projectRow(db, "wrkspc_research")
    expect(research).toMatchObject({ provider_id: AN, name: "Research" })
    expect(keyRow(db, "k_alice")).toMatchObject({
      owner_person_id: "p-alice",
      assignment_source: "auto",
      org_project_id: research.id,
      external_created_by: "user_alice",
      external_created_by_email: "alice@liatrio.com",
      external_status: "active",
      spend_attribution: null,
      team_id: null,
      unresolved_reason: null,
    })
    expect(db.table("people").filter((p) => p.email === "alice@liatrio.com")).toHaveLength(1)
    // Rollup mirror: the key's spend goes to Alice and her team.
    expect(resolveAttribution(anRow("k_alice", "wrkspc_research"), buildOrgIndex(orgOf(db)))).toMatchObject({
      person_id: "p-alice",
      team_id: TEAM_OPS,
      project_id: "wrkspc_research",
    })
  })

  test("an unknown creator email creates a person with no team", async () => {
    const db = seed()
    const s = await applyAnthropicKeySync(asClient(db), AN, listing())
    expect(s.people_created).toBe(1)
    const p = db.table("people").find((x) => x.email === "new.dev@liatrio.com") as any
    expect(p).toMatchObject({ display_name: "New Dev", team_id: null })
    expect(keyRow(db, "k_new").owner_person_id).toBe(p.id)
  })

  test("principal beats created_by", async () => {
    const db = seed()
    await applyAnthropicKeySync(asClient(db), AN, listing())
    expect(keyRow(db, "k_principal")).toMatchObject({
      owner_person_id: "p-bob",
      external_created_by: "user_bob",
      external_created_by_email: "bob@liatrio.com",
    })
  })

  test("service account, deleted, null and unmatched creators get no owner, are counted and keep a reason", async () => {
    const db = seed()
    const s = await applyAnthropicKeySync(asClient(db), AN, listing())
    expect(s.unresolved_creators).toBe(4)
    expect(Object.fromEntries(s.unresolved.map((u) => [u.external_key_id, u.reason]))).toEqual({
      k_svc: "service_account",
      k_deleted: "deleted_user",
      k_null: "no_creator",
      k_unmatched: "unmatched_creator",
    })
    expect(keyRow(db, "k_svc")).toMatchObject({ owner_person_id: null, unresolved_reason: "service_account", external_created_by: "service_account:svcacct_1" })
    expect(keyRow(db, "k_deleted")).toMatchObject({ owner_person_id: null, unresolved_reason: "deleted_user", external_created_by: "user_gone" })
    expect(keyRow(db, "k_null")).toMatchObject({ owner_person_id: null, unresolved_reason: "no_creator", external_created_by: null })
    expect(keyRow(db, "k_unmatched")).toMatchObject({ owner_person_id: null, unresolved_reason: "unmatched_creator" })
    // They still sit under their workspace project (auto), so its team applies once set.
    const research = projectRow(db, "wrkspc_research")
    expect(keyRow(db, "k_svc")).toMatchObject({ org_project_id: research.id, assignment_source: "auto" })
    expect(resolveAttribution(anRow("k_svc", "wrkspc_research"), buildOrgIndex(orgOf(db))).team_id).toBeNull()
    research.team_id = TEAM_RES
    expect(resolveAttribution(anRow("k_svc", "wrkspc_research"), buildOrgIndex(orgOf(db)))).toMatchObject({
      person_id: null,
      team_id: TEAM_RES,
    })
  })

  test("archived keys are synced with their status", async () => {
    const db = seed()
    await applyAnthropicKeySync(asClient(db), AN, listing())
    expect(keyRow(db, "k_archived")).toMatchObject({
      external_status: "archived",
      owner_person_id: "p-alice",
      org_project_id: projectRow(db, "wrkspc_old").id,
    })
    expect(projectRow(db, "wrkspc_old").name).toBe("Old (archived)")
  })

  test("the default workspace becomes the 'Default' project and holds its keys", async () => {
    const db = seed()
    await applyAnthropicKeySync(asClient(db), AN, listing())
    const def = projectRow(db, DEFAULT_WORKSPACE_PROJECT_ID)
    expect(def).toMatchObject({ provider_id: AN, name: "Default" })
    expect(def.team_id ?? null).toBeNull()
    expect(keyRow(db, "k_default").org_project_id).toBe(def.id)
    // Default-workspace rows carry no project_id: the key's project applies.
    def.team_id = TEAM_RES
    db.table("people").find((p) => p.id === "p-alice")!.team_id = null
    expect(resolveAttribution(anRow("k_default", null), buildOrgIndex(orgOf(db)))).toMatchObject({
      person_id: "p-alice",
      project_id: DEFAULT_WORKSPACE_PROJECT_ID,
      team_id: TEAM_RES,
    })
  })

  test("a default workspace listed with its own id maps to the same 'Default' project", async () => {
    const db = seed()
    await applyAnthropicKeySync(
      asClient(db),
      AN,
      listing({
        keys: [key("k_d", { workspace_id: "wrkspc_default" })],
        workspaces: [{ id: "wrkspc_default", name: "Default Workspace", is_default: true }],
      })
    )
    expect(db.table("org_projects").map((p) => p.external_project_id)).toEqual([DEFAULT_WORKSPACE_PROJECT_ID])
    expect(keyRow(db, "k_d").org_project_id).toBe(projectRow(db, DEFAULT_WORKSPACE_PROJECT_ID).id)
  })

  test("re-sync is idempotent: second run is all unchanged and writes nothing", async () => {
    const db = seed()
    await applyAnthropicKeySync(asClient(db), AN, listing())
    const before = db.writes.length
    const s = await applyAnthropicKeySync(asClient(db), AN, listing())
    expect(s).toMatchObject({ created: 0, updated: 0, unchanged: 9, manual_kept: 0, people_created: 0, projects_created: 0 })
    expect(db.writes.length).toBe(before)
  })

  test("a manual owner (and manual team / project) is never overwritten", async () => {
    const db = seed()
    await applyAnthropicKeySync(asClient(db), AN, listing())
    db.table("org_projects").push({ id: "pr-manual", provider_id: AN, external_project_id: "manual", name: "Manual", team_id: null })
    Object.assign(keyRow(db, "k_alice"), { owner_person_id: "p-bob", assignment_source: "manual" })
    Object.assign(keyRow(db, "k_svc"), { team_id: TEAM_RES, assignment_source: "manual" })
    Object.assign(keyRow(db, "k_new"), { org_project_id: "pr-manual", assignment_source: "manual" })
    const snapshot = (ext: string) => {
      const { owner_person_id, team_id, org_project_id, assignment_source, name } = keyRow(db, ext)
      return { owner_person_id, team_id, org_project_id, assignment_source, name }
    }
    const before = ["k_alice", "k_svc", "k_new"].map(snapshot)
    const s1 = await applyAnthropicKeySync(asClient(db), AN, listing({ keys: keys().map((k) => ({ ...k, name: `${k.name} renamed` })) }))
    const s2 = await applyAnthropicKeySync(asClient(db), AN, listing())
    expect(s1.manual_kept).toBe(3)
    expect(s2.manual_kept).toBe(3)
    expect(["k_alice", "k_svc", "k_new"].map(snapshot)).toEqual(before)
    // A manual key isn't counted as unresolved.
    expect(s2.unresolved.map((u) => u.external_key_id)).not.toContain("k_svc")
  })

  test("a manually set project name or team is never overwritten", async () => {
    const db = seed()
    db.table("org_projects").push({ id: "pr-r", provider_id: AN, external_project_id: "wrkspc_research", name: "Research (renamed)", team_id: TEAM_RES })
    db.table("org_projects").push({ id: "pr-d", provider_id: AN, external_project_id: DEFAULT_WORKSPACE_PROJECT_ID, name: "Shared", team_id: TEAM_OPS })
    await applyAnthropicKeySync(asClient(db), AN, listing())
    expect(projectRow(db, "wrkspc_research")).toMatchObject({ id: "pr-r", name: "Research (renamed)", team_id: TEAM_RES })
    expect(projectRow(db, DEFAULT_WORKSPACE_PROJECT_ID)).toMatchObject({ id: "pr-d", name: "Shared", team_id: TEAM_OPS })
  })

  test("a transient users-list failure keeps the existing auto owner, email and reason", async () => {
    const db = seed()
    await applyAnthropicKeySync(asClient(db), AN, listing())
    const s = await applyAnthropicKeySync(asClient(db), AN, listing({ users: null }))
    expect(s.users_unavailable).toBe(true)
    expect(keyRow(db, "k_alice")).toMatchObject({ owner_person_id: "p-alice", external_created_by_email: "alice@liatrio.com" })
    expect(keyRow(db, "k_deleted")).toMatchObject({ owner_person_id: null, unresolved_reason: "deleted_user" })
    // Non-user creators don't need the users list: still resolved the same way.
    expect(keyRow(db, "k_svc").unresolved_reason).toBe("service_account")
  })

  test("a creator removed from the org loses the auto owner", async () => {
    const db = seed()
    await applyAnthropicKeySync(asClient(db), AN, listing())
    const u = users()
    u.delete("user_alice")
    await applyAnthropicKeySync(asClient(db), AN, listing({ users: u }))
    expect(keyRow(db, "k_alice")).toMatchObject({ owner_person_id: null, unresolved_reason: "deleted_user", assignment_source: "auto" })
  })

  test("a user_actor row on a key owned by someone else resolves to the actor", async () => {
    const db = seed()
    await applyAnthropicKeySync(asClient(db), AN, listing())
    expect(keyRow(db, "k_alice").owner_person_id).toBe("p-alice")
    const r = resolveAttribution(anRow("k_alice", "wrkspc_research", { email: "bob@liatrio.com", id: "user_bob" }), buildOrgIndex(orgOf(db)))
    expect(r.person_id).toBe("p-bob")
  })

  test("keys of other providers with the same id are never touched", async () => {
    const db = seed()
    db.table("org_api_keys").push({ id: "other", provider_id: "prov-aigw", external_key_id: "k_alice", name: "x", owner_person_id: null, team_id: null, org_project_id: null, assignment_source: null })
    await applyAnthropicKeySync(asClient(db), AN, listing())
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
            ? { eq: () => ({ in: async () => ({ data: null, error: { code: "42703", message: 'column "external_status" does not exist' } }) }) }
            : select(cols)
        const insert = q.insert.bind(q)
        q.insert = (row: any) => {
          if ("external_status" in row || "unresolved_reason" in row) throw new Error("017 column written before 017")
          return insert(row)
        }
        return q
      },
    }
    const s = await applyAnthropicKeySync(client as unknown as SupabaseClient, AN, listing())
    expect(s.created).toBe(9)
    expect(keyRow(db, "k_alice")).toMatchObject({ owner_person_id: "p-alice" })
    expect(keyRow(db, "k_alice")).not.toHaveProperty("external_status")
  })
})

describe("resolveCreator", () => {
  test("principal of another type is treated as a service account", () => {
    expect(resolveCreator(key("k", { principal: { user_id: null, type: "service_account" } }), users())).toMatchObject({
      reason: "service_account",
    })
  })
  test("a created_by with no type is a user", () => {
    expect(resolveCreator(key("k", { created_by: { id: "user_alice", type: null } }), users())).toMatchObject({
      email: "alice@liatrio.com",
      reason: null,
    })
  })
})

describe("listAnthropicKeyData / syncAnthropicKeys (mocked fetch)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

  test("pages keys with after_id (limit 1000, all statuses) and lists users and workspaces", async () => {
    const calls: string[] = []
    global.fetch = jest.fn(async (url: any, init: any) => {
      const u = new URL(String(url))
      calls.push(`${u.pathname}?${u.searchParams}`)
      expect(init.headers["x-api-key"]).toBe("test-admin-key")
      if (u.pathname === "/v1/organizations/api_keys") {
        if (!u.searchParams.get("after_id")) return res({ data: [{ id: "k1", name: "one", status: "active", workspace_id: null, created_by: { id: "user_alice", type: "user" } }], has_more: true, last_id: "k1" })
        return res({ data: [{ id: "k2", name: "two", status: "archived", workspace_id: "wrkspc_x", created_by: null }], has_more: false, last_id: "k2" })
      }
      if (u.pathname === "/v1/organizations/users") return res({ data: [{ id: "user_alice", email: "Alice@Liatrio.com", name: "Alice" }], has_more: false })
      if (u.pathname === "/v1/organizations/workspaces") return res({ data: [{ id: "wrkspc_x", name: "X" }], has_more: false })
      throw new Error(`unexpected ${u}`)
    }) as any
    const l = await listAnthropicKeyData("test-admin-key")
    expect(calls).toEqual([
      "/v1/organizations/api_keys?limit=1000",
      "/v1/organizations/api_keys?limit=1000&after_id=k1",
      "/v1/organizations/users?limit=1000",
      "/v1/organizations/workspaces?limit=1000&include_default=true&include_archived=true",
    ])
    expect(l.keys.map((k) => [k.id, k.status])).toEqual([
      ["k1", "active"],
      ["k2", "archived"],
    ])
    expect(l.users?.get("user_alice")).toEqual({ email: "alice@liatrio.com", name: "Alice" })
    expect(l.workspaces).toEqual([{ id: "wrkspc_x", name: "X", is_default: false }])
  })

  test("a key-list failure throws and writes nothing", async () => {
    const db = seed()
    db.table("org_api_keys").push({ id: "ak-1", provider_id: AN, external_key_id: "k_auto", name: "auto", owner_person_id: "p-alice", team_id: null, org_project_id: null, assignment_source: "auto" } as any)
    const before = JSON.stringify(db.table("org_api_keys"))
    global.fetch = jest.fn(async () => res({ error: { type: "permission_error" } }, 403)) as any
    await expect(syncAnthropicKeys(asClient(db), { adminKey: "test-admin-key", providerId: AN })).rejects.toBeInstanceOf(AnthropicKeySyncError)
    expect(JSON.stringify(db.table("org_api_keys"))).toBe(before)
    expect(db.table("org_projects")).toHaveLength(0)
    expect(db.writes).toHaveLength(0)
  })

  test("users and workspaces failures are best-effort", async () => {
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname === "/v1/organizations/api_keys") return res({ data: [{ id: "k1", workspace_id: "wrkspc_x", created_by: { id: "user_alice", type: "user" } }], has_more: false })
      return res({}, 403)
    }) as any
    const db = seed()
    const s = await syncAnthropicKeys(asClient(db), { adminKey: "test-admin-key", providerId: AN })
    expect(s).toMatchObject({ created: 1, users_unavailable: true, workspaces_unavailable: true, unresolved_creators: 0 })
    expect(keyRow(db, "k1")).toMatchObject({ owner_person_id: null, external_created_by: "user_alice", unresolved_reason: null })
    expect(projectRow(db, "wrkspc_x")).toMatchObject({ name: null })
  })
})
