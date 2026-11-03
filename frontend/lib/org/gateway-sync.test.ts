/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures */
/**
 * AI Gateway key sync (issue #24): in-memory Supabase fake, mocked fetch, no network.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { FakeSupabase } from "./admin/testing/fake-supabase"
import { buildOrgIndex, resolveAttribution } from "./attribution"
import {
  applyGatewayKeySync,
  isManual,
  listTeamMembers,
  planKey,
  syncGatewayKeys,
  type SyncKeyRow,
  type TeamMember,
} from "./gateway-sync"
import { GatewayApiError, type GatewayKey } from "@/lib/collectors/vercel-ai-gateway"
import type { OrgData } from "./types"

const GW = "prov-aigw"
const TEAM_WEB = "team-web"
const TEAM_OPS = "team-ops"

const members = new Map<string, TeamMember>([
  ["uid_alice", { email: "alice@liatrio.com", name: "Alice" }],
  ["uid_new", { email: "New.Dev@Liatrio.com".toLowerCase(), name: "New Dev" }],
])

const keys = (): GatewayKey[] => [
  { id: "k_user", name: "alice laptop", createdBy: "uid_alice", spendAttribution: "user" },
  { id: "k_new", name: "new dev key", createdBy: "uid_new", spendAttribution: "user" },
  { id: "k_team", name: "shared", createdBy: "uid_alice", spendAttribution: "team" },
  { id: "k_unset", name: "legacy", createdBy: "uid_alice" },
  { id: "k_proj", name: "web app", createdBy: "uid_alice", spendAttribution: "team", projectId: "prj_web", projectName: "Website" },
  { id: "k_ghost", name: "ex-employee", createdBy: "uid_gone", spendAttribution: "user" },
]

function seed() {
  return new FakeSupabase({
    providers: [{ id: GW, name: "vercel-ai-gateway" }],
    teams: [
      { id: TEAM_WEB, name: "Web", department_id: null },
      { id: TEAM_OPS, name: "Ops", department_id: null },
    ],
    people: [{ id: "p-alice", email: "alice@liatrio.com", display_name: "Alice", team_id: TEAM_OPS, active: true }],
    person_identities: [],
    org_api_keys: [],
    org_projects: [],
  })
}

const asClient = (db: FakeSupabase) => db as unknown as SupabaseClient
const keyRow = (db: FakeSupabase, ext: string) => db.table("org_api_keys").find((k) => k.external_key_id === ext) as any

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

const gatewayRow = (keyId: string, projectId?: string) => ({
  provider_id: GW,
  metadata: {
    attribution: { api_key_id: keyId, granularity: "api_key", ...(projectId ? { project_id: projectId } : {}) },
  },
})

describe("applyGatewayKeySync", () => {
  test("user key with a known creator resolves to that person (existing, matched by email)", async () => {
    const db = seed()
    const s = await applyGatewayKeySync(asClient(db), GW, keys(), members)
    expect(s.status).toBe("success")
    const k = keyRow(db, "k_user")
    expect(k).toMatchObject({
      owner_person_id: "p-alice",
      assignment_source: "auto",
      external_created_by: "uid_alice",
      external_created_by_email: "alice@liatrio.com",
      spend_attribution: "user",
      team_id: null,
    })
    // Alice was matched, not duplicated.
    expect(db.table("people").filter((p) => p.email === "alice@liatrio.com")).toHaveLength(1)
    // And the rollup mirror resolves the key's spend to Alice and her team.
    const r = resolveAttribution(gatewayRow("k_user"), buildOrgIndex(orgOf(db)))
    expect(r).toMatchObject({ person_id: "p-alice", team_id: TEAM_OPS, org_api_key_id: k.id })
  })

  test("an unknown creator email creates a person with no team", async () => {
    const db = seed()
    const s = await applyGatewayKeySync(asClient(db), GW, keys(), members)
    expect(s.people_created).toBe(1)
    const p = db.table("people").find((x) => x.email === "new.dev@liatrio.com") as any
    expect(p).toMatchObject({ display_name: "New Dev", team_id: null })
    expect(keyRow(db, "k_new").owner_person_id).toBe(p.id)
  })

  test("team-attributed and unset keys stay unassigned", async () => {
    const db = seed()
    await applyGatewayKeySync(asClient(db), GW, keys(), members)
    for (const ext of ["k_team", "k_unset"]) {
      expect(keyRow(db, ext)).toMatchObject({ owner_person_id: null, team_id: null, org_project_id: null, assignment_source: null })
    }
    expect(keyRow(db, "k_team").spend_attribution).toBe("team")
    expect(keyRow(db, "k_unset").spend_attribution).toBeNull()
  })

  test("a user key whose creator can't be mapped stays unassigned and is counted", async () => {
    const db = seed()
    const s = await applyGatewayKeySync(asClient(db), GW, keys(), members)
    expect(s.unresolved_creators).toBe(1)
    expect(keyRow(db, "k_ghost")).toMatchObject({ owner_person_id: null, external_created_by: "uid_gone", external_created_by_email: null })
  })

  test("a project-scoped key upserts org_projects and resolves to the project's team once set", async () => {
    const db = seed()
    const s = await applyGatewayKeySync(asClient(db), GW, keys(), members)
    expect(s.projects_created).toBe(1)
    const proj = db.table("org_projects").find((p) => p.external_project_id === "prj_web") as any
    expect(proj).toMatchObject({ provider_id: GW, name: "Website" })
    expect(keyRow(db, "k_proj")).toMatchObject({ org_project_id: proj.id, assignment_source: "auto", owner_person_id: null })

    // No project team yet: Unassigned.
    expect(resolveAttribution(gatewayRow("k_proj", "prj_web"), buildOrgIndex(orgOf(db))).team_id).toBeNull()
    // An admin gives the project a team: the key's spend follows it.
    proj.team_id = TEAM_WEB
    const r = resolveAttribution(gatewayRow("k_proj", "prj_web"), buildOrgIndex(orgOf(db)))
    expect(r).toMatchObject({ team_id: TEAM_WEB, project_id: "prj_web", person_id: null })
    // Rows without project_id (e.g. collected before #24) use the key's project.
    expect(resolveAttribution(gatewayRow("k_proj"), buildOrgIndex(orgOf(db)))).toMatchObject({ team_id: TEAM_WEB, project_id: "prj_web" })

    // Re-sync never touches the project's team or renames it.
    await applyGatewayKeySync(asClient(db), GW, keys().map((k) => (k.projectId ? { ...k, projectName: "Renamed" } : k)), members)
    expect(db.table("org_projects").find((p) => p.external_project_id === "prj_web")).toMatchObject({ team_id: TEAM_WEB, name: "Website" })
  })

  test("re-running with nothing changed writes nothing", async () => {
    const db = seed()
    await applyGatewayKeySync(asClient(db), GW, keys(), members)
    const before = db.writes.length
    const s = await applyGatewayKeySync(asClient(db), GW, keys(), members)
    expect(s).toMatchObject({ keys_inserted: 0, keys_updated: 0, keys_unchanged: 6, people_created: 0, projects_created: 0 })
    expect(db.writes.length).toBe(before)
  })

  test("manual owner, team and project assignments survive re-syncs", async () => {
    const db = seed()
    await applyGatewayKeySync(asClient(db), GW, keys(), members)
    const other = { id: "p-bob", email: "bob@liatrio.com", display_name: "Bob", team_id: null, active: true }
    db.table("people").push(other)
    db.table("org_projects").push({ id: "pr-manual", provider_id: GW, external_project_id: "prj_manual", name: "Manual", team_id: null })

    // Admin: k_user -> Bob (owner), k_team -> team Web, k_proj -> another project, k_unset -> owner Bob.
    Object.assign(keyRow(db, "k_user"), { owner_person_id: "p-bob", assignment_source: "manual" })
    Object.assign(keyRow(db, "k_team"), { team_id: TEAM_WEB, assignment_source: "manual" })
    Object.assign(keyRow(db, "k_proj"), { org_project_id: "pr-manual", assignment_source: "manual" })
    // A key assigned before migration 015 (no source) counts as manual too.
    Object.assign(keyRow(db, "k_unset"), { owner_person_id: "p-bob", assignment_source: null })

    const s1 = await applyGatewayKeySync(asClient(db), GW, keys(), members)
    const s2 = await applyGatewayKeySync(asClient(db), GW, keys(), members)
    expect(s1.keys_manual).toBe(4)
    expect(s2.keys_manual).toBe(4)
    expect(keyRow(db, "k_user")).toMatchObject({ owner_person_id: "p-bob", assignment_source: "manual" })
    expect(keyRow(db, "k_team")).toMatchObject({ team_id: TEAM_WEB, owner_person_id: null, assignment_source: "manual" })
    expect(keyRow(db, "k_proj")).toMatchObject({ org_project_id: "pr-manual", assignment_source: "manual" })
    expect(keyRow(db, "k_unset")).toMatchObject({ owner_person_id: "p-bob", assignment_source: null })
  })

  test("switching a key from user to team clears an auto owner; an unresolved creator keeps it", async () => {
    const db = seed()
    await applyGatewayKeySync(asClient(db), GW, keys(), members)
    // Members API down this run: auto owner kept.
    await applyGatewayKeySync(asClient(db), GW, keys(), new Map())
    expect(keyRow(db, "k_user")).toMatchObject({ owner_person_id: "p-alice", external_created_by_email: "alice@liatrio.com" })
    // spendAttribution flipped to team in Vercel: owner cleared.
    await applyGatewayKeySync(
      asClient(db),
      GW,
      keys().map((k) => (k.id === "k_user" ? { ...k, spendAttribution: "team" as const } : k)),
      members
    )
    expect(keyRow(db, "k_user")).toMatchObject({ owner_person_id: null, assignment_source: null, spend_attribution: "team" })
  })

  test("keys of other providers with the same id are never touched", async () => {
    const db = seed()
    db.table("org_api_keys").push({ id: "other", provider_id: "prov-openai", external_key_id: "k_user", name: "x", owner_person_id: null, team_id: null, org_project_id: null, assignment_source: null })
    await applyGatewayKeySync(asClient(db), GW, keys(), members)
    expect(db.table("org_api_keys").find((k) => k.id === "other")).toMatchObject({ owner_person_id: null, name: "x" })
  })
})

describe("planKey", () => {
  const base: SyncKeyRow = {
    id: "row",
    provider_id: GW,
    external_key_id: "k",
    name: "k",
    owner_person_id: null,
    team_id: null,
    org_project_id: null,
    external_created_by: "u",
    external_created_by_email: null,
    spend_attribution: "team",
    assignment_source: null,
  }

  test("manual rows only get metadata updates", () => {
    const plan = planKey(
      { id: "k", name: "renamed", createdBy: "u", spendAttribution: "user", projectId: "prj" },
      { ...base, team_id: "t", assignment_source: "manual" },
      { creatorEmail: "a@x.com", ownerPersonId: "p", orgProjectId: "pr" },
      GW
    )
    expect(plan).toEqual({ op: "update", id: "row", patch: { external_created_by_email: "a@x.com", spend_attribution: "user" } })
  })

  test("isManual: explicit flag, or anything assigned without a source", () => {
    expect(isManual({ assignment_source: "manual", owner_person_id: null, team_id: null, org_project_id: null })).toBe(true)
    expect(isManual({ assignment_source: "auto", owner_person_id: "p", team_id: null, org_project_id: null })).toBe(false)
    expect(isManual({ assignment_source: null, owner_person_id: null, team_id: "t", org_project_id: null })).toBe(true)
    expect(isManual({ assignment_source: null, owner_person_id: null, team_id: null, org_project_id: null })).toBe(false)
  })
})

describe("listTeamMembers / syncGatewayKeys (mocked fetch)", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

  test("follows pagination and lower-cases emails; a failed page keeps what was read", async () => {
    const calls: string[] = []
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      calls.push(u.pathname + "?" + (u.searchParams.get("until") ?? ""))
      if (!u.searchParams.get("until")) return res({ members: [{ uid: "u1", email: "A@X.com", name: "A" }], pagination: { next: 5 } })
      return res({}, 403)
    }) as any
    const m = await listTeamMembers("test-vercel-token", "team_x")
    expect(calls).toEqual(["/v3/teams/team_x/members?", "/v3/teams/team_x/members?5"])
    expect(m.get("u1")).toEqual({ email: "a@x.com", name: "A" })
  })

  test("end to end: lists keys, project names and members, then syncs", async () => {
    const hosts: string[] = []
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      hosts.push(u.pathname)
      if (u.pathname === "/v1/api-keys") {
        return res({
          apiKeys: [
            { id: "k_user", name: "alice laptop", createdBy: "uid_alice", metadata: { spendAttribution: "user" } },
            { id: "k_proj", name: "web", createdBy: "uid_alice", projectId: "prj_web", metadata: { spendAttribution: "team" } },
          ],
        })
      }
      if (u.pathname === "/v9/projects/prj_web") return res({ id: "prj_web", name: "Website" })
      if (u.pathname === "/v3/teams/team_x/members") return res({ members: [{ uid: "uid_alice", email: "alice@liatrio.com" }] })
      throw new Error(`unexpected ${u}`)
    }) as any
    const db = seed()
    const s = await syncGatewayKeys(asClient(db), { vercelToken: "test-vercel-token", teamId: "team_x", providerId: GW })
    expect(s).toMatchObject({ keys_listed: 2, keys_inserted: 2, projects_created: 1 })
    expect(keyRow(db, "k_user").owner_person_id).toBe("p-alice")
    expect(db.table("org_projects")[0]).toMatchObject({ external_project_id: "prj_web", name: "Website" })
  })

  test("issue #28: keys with no spend are inserted and counts are reported", async () => {
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname === "/v1/api-keys") {
        return res({
          apiKeys: [
            { id: "k_idle", name: "never used", createdBy: "uid_x" },
            { id: "k_idle_proj", name: "idle web", projectId: "prj_idle" },
          ],
        })
      }
      if (u.pathname === "/v9/projects/prj_idle") return res({ name: "Idle site" })
      throw new Error(`unexpected ${u}`)
    }) as any
    const db = seed()
    // No cost_records at all: the sync works from Vercel's key list alone.
    const s = await syncGatewayKeys(asClient(db), { vercelToken: "test-vercel-token", teamId: "team_x", providerId: GW })
    expect(s).toMatchObject({ status: "success", created: 2, updated: 0, unchanged: 0, manual_kept: 0 })
    expect(keyRow(db, "k_idle")).toMatchObject({ name: "never used", external_created_by: "uid_x", assignment_source: null })
    expect(keyRow(db, "k_idle_proj").org_project_id).toBeTruthy()

    // A second run with nothing new changes nothing.
    const again = await syncGatewayKeys(asClient(db), { vercelToken: "test-vercel-token", teamId: "team_x", providerId: GW })
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2, manual_kept: 0 })
  })

  test("issue #28: manual assignments survive and are counted as kept", async () => {
    const db = seed()
    db.table("org_api_keys").push({
      id: "ak-manual",
      provider_id: GW,
      external_key_id: "k_user",
      name: "renamed by admin",
      owner_person_id: null,
      team_id: TEAM_WEB,
      org_project_id: null,
      assignment_source: "manual",
    } as any)
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname === "/v1/api-keys") {
        return res({ apiKeys: [{ id: "k_user", name: "alice laptop", createdBy: "uid_alice", metadata: { spendAttribution: "user" } }] })
      }
      if (u.pathname === "/v3/teams/team_x/members") return res({ members: [{ uid: "uid_alice", email: "alice@liatrio.com" }] })
      throw new Error(`unexpected ${u}`)
    }) as any
    const s = await syncGatewayKeys(asClient(db), { vercelToken: "test-vercel-token", teamId: "team_x", providerId: GW })
    expect(s).toMatchObject({ created: 0, updated: 1, manual_kept: 1 })
    // Metadata refreshed, but owner / team / name set by hand are kept.
    expect(keyRow(db, "k_user")).toMatchObject({
      name: "renamed by admin",
      owner_person_id: null,
      team_id: TEAM_WEB,
      assignment_source: "manual",
      external_created_by_email: "alice@liatrio.com",
    })
  })

  test("issue #28: a Vercel key-list failure throws and writes nothing", async () => {
    const db = seed()
    db.table("org_api_keys").push({
      id: "ak-1",
      provider_id: GW,
      external_key_id: "k_auto",
      name: "auto key",
      owner_person_id: "p-alice",
      team_id: null,
      org_project_id: null,
      assignment_source: "auto",
    } as any)
    const before = JSON.stringify(db.table("org_api_keys"))
    global.fetch = jest.fn(async () => res({ error: "forbidden" }, 403)) as any
    await expect(
      syncGatewayKeys(asClient(db), { vercelToken: "test-vercel-token", teamId: "team_x", providerId: GW })
    ).rejects.toBeInstanceOf(GatewayApiError)
    expect(JSON.stringify(db.table("org_api_keys"))).toBe(before)
    expect(db.table("people")).toHaveLength(1)
    expect(db.table("org_projects")).toHaveLength(0)
  })

  test("issue #28: a failure on a later key-list page also aborts the sync", async () => {
    const db = seed()
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (!u.searchParams.get("until")) return res({ apiKeys: [{ id: "k_a" }], pagination: { next: 2 } })
      return res({}, 401)
    }) as any
    await expect(
      syncGatewayKeys(asClient(db), { vercelToken: "test-vercel-token", teamId: "team_x", providerId: GW })
    ).rejects.toThrow(/HTTP 401/)
    expect(db.table("org_api_keys")).toHaveLength(0)
  })
})
