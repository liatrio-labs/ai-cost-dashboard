/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures */
/**
 * Issue #44: the key syncs store the provider's key creation date in
 * org_api_keys.provider_created_at (migration 018) when the provider reports
 * it, per provider: Anthropic created_at (RFC 3339), OpenAI created_at (epoch
 * seconds), Vercel AI Gateway createdAt (epoch ms). Mocked fetch and an
 * in-memory Supabase fake; no network, no database.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { FakeSupabase } from "./admin/testing/fake-supabase"
import { applyAnthropicKeySync, listAnthropicApiKeys, type AnthropicApiKey } from "./anthropic-key-sync"
import { applyOpenAIKeySync, listOpenAIKeyData, parseOpenAIKey, type OpenAIApiKey } from "./openai-key-sync"
import { applyGatewayKeySync } from "./gateway-sync"
import { listGatewayKeysWithProjects, type GatewayKey } from "@/lib/collectors/vercel-ai-gateway"
import { parseProviderTimestamp, providerCreatedAtChange } from "./sync-helpers"

const AN = "prov-anthropic"
const OA = "prov-openai"
const GW = "prov-aigw"

const seed = () =>
  new FakeSupabase({
    providers: [
      { id: AN, name: "anthropic" },
      { id: OA, name: "openai" },
      { id: GW, name: "vercel-ai-gateway" },
    ],
    teams: [],
    people: [{ id: "p-alice", email: "alice@liatrio.com", display_name: "Alice", team_id: null, active: true }],
    person_identities: [],
    org_api_keys: [],
    org_projects: [],
  })
const asClient = (db: FakeSupabase) => db as unknown as SupabaseClient
const keyRow = (db: FakeSupabase, provider: string, ext: string) =>
  db.table("org_api_keys").find((k) => k.provider_id === provider && k.external_key_id === ext) as any

/**
 * The fake as a database without migration 018: any org_api_keys select of
 * provider_created_at fails with 42703, and writing it throws.
 */
function without018(db: FakeSupabase) {
  return {
    from(table: string) {
      const q = (db as any).from(table)
      if (table !== "org_api_keys") return q
      const select = q.select.bind(q)
      q.select = (cols: string) =>
        /provider_created_at/.test(cols)
          ? { eq: () => ({ in: async () => ({ data: null, error: { code: "42703", message: 'column "provider_created_at" does not exist' } }) }) }
          : select(cols)
      for (const m of ["insert", "update"] as const) {
        const orig = q[m].bind(q)
        q[m] = (row: any) => {
          if ("provider_created_at" in row) throw new Error("018 column written before 018")
          return orig(row)
        }
      }
      return q
    },
  } as unknown as SupabaseClient
}

const res = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
})

describe("parseProviderTimestamp / providerCreatedAtChange", () => {
  test("RFC 3339, epoch seconds and epoch ms; junk is unknown", () => {
    expect(parseProviderTimestamp("2025-01-02T03:04:05Z")).toBe("2025-01-02T03:04:05.000Z")
    expect(parseProviderTimestamp(1735787045)).toBe("2025-01-02T03:04:05.000Z")
    expect(parseProviderTimestamp("1735787045")).toBe("2025-01-02T03:04:05.000Z")
    expect(parseProviderTimestamp(1735787045000)).toBe("2025-01-02T03:04:05.000Z")
    for (const v of [null, undefined, "", "soon", 0, -5, {}, NaN]) expect(parseProviderTimestamp(v)).toBeNull()
  })
  test("only a known, different date is written; the same instant in another format is not", () => {
    expect(providerCreatedAtChange(null, "2025-01-02T03:04:05.000Z")).toBe("2025-01-02T03:04:05.000Z")
    expect(providerCreatedAtChange("2025-01-02T03:04:05+00:00", "2025-01-02T03:04:05.000Z")).toBeUndefined()
    expect(providerCreatedAtChange("2025-01-02T03:04:05+00:00", null)).toBeUndefined()
    expect(providerCreatedAtChange("2025-01-01T00:00:00+00:00", "2025-01-02T03:04:05.000Z")).toBe("2025-01-02T03:04:05.000Z")
  })
})

describe("Anthropic: created_at -> provider_created_at", () => {
  const key = (id: string, extra: Partial<AnthropicApiKey> = {}): AnthropicApiKey => ({
    id,
    name: id,
    status: "active",
    workspace_id: null,
    created_by: { id: "user_alice", type: "user" },
    principal: null,
    ...extra,
  })
  const listing = (keys: AnthropicApiKey[]) => ({ keys, users: new Map([["user_alice", { email: "alice@liatrio.com", name: "Alice" }]]), workspaces: [] })

  test("the API's created_at is parsed from the key list", async () => {
    global.fetch = jest.fn(async () =>
      res({ data: [{ id: "k1", name: "one", status: "active", created_at: "2025-03-04T05:06:07Z", created_by: { id: "user_alice", type: "user" } }, { id: "k2" }], has_more: false })
    ) as any
    const keys = await listAnthropicApiKeys("test-admin-key")
    expect(keys.map((k) => [k.id, k.created_at])).toEqual([
      ["k1", "2025-03-04T05:06:07.000Z"],
      ["k2", null],
    ])
  })

  test("stored on insert, refreshed on change, kept when the API omits it", async () => {
    const db = seed()
    await applyAnthropicKeySync(asClient(db), AN, listing([key("k1", { created_at: "2025-03-04T05:06:07.000Z" }), key("k2")]))
    expect(keyRow(db, AN, "k1").provider_created_at).toBe("2025-03-04T05:06:07.000Z")
    expect(keyRow(db, AN, "k2").provider_created_at ?? null).toBeNull()

    // Same instant as PostgREST returns it: no write.
    keyRow(db, AN, "k1").provider_created_at = "2025-03-04T05:06:07+00:00"
    const again = await applyAnthropicKeySync(asClient(db), AN, listing([key("k1", { created_at: "2025-03-04T05:06:07.000Z" })]))
    expect(again.unchanged).toBe(1)

    // Omitted this time: the stored date is kept.
    await applyAnthropicKeySync(asClient(db), AN, listing([key("k1")]))
    expect(keyRow(db, AN, "k1").provider_created_at).toBe("2025-03-04T05:06:07+00:00")
  })

  test("before migration 018 the date is neither read nor written", async () => {
    const db = seed()
    const s = await applyAnthropicKeySync(without018(db), AN, listing([key("k1", { created_at: "2025-03-04T05:06:07.000Z" })]))
    expect(s.created).toBe(1)
    expect(keyRow(db, AN, "k1")).not.toHaveProperty("provider_created_at")
    expect(keyRow(db, AN, "k1")).toMatchObject({ owner_person_id: "p-alice", external_status: "active" })
  })
})

describe("OpenAI: created_at (epoch seconds) -> provider_created_at", () => {
  const key = (id: string, extra: Partial<OpenAIApiKey> = {}): OpenAIApiKey => ({
    id,
    name: id,
    project_id: "proj_1",
    owner: { type: "user", id: "u1", email: "alice@liatrio.com", name: null },
    source: "api",
    ...extra,
  })

  test("parseOpenAIKey and the admin list read created_at", async () => {
    expect(parseOpenAIKey({ id: "k", created_at: 1735787045 }, "p")?.created_at).toBe("2025-01-02T03:04:05.000Z")
    expect(parseOpenAIKey({ id: "k" }, "p")).not.toHaveProperty("created_at")
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname === "/v1/organization/projects") return res({ data: [{ id: "proj_1", name: "P" }], has_more: false })
      if (u.pathname === "/v1/organization/projects/proj_1/api_keys")
        return res({ data: [{ id: "key_1", name: "k", created_at: 1735787045, owner: { type: "user", user: { id: "u1", email: "a@b.com" } } }], has_more: false })
      throw new Error(`unexpected ${u}`)
    }) as any
    const l = await listOpenAIKeyData("test-admin-key")
    expect(l.keys[0].created_at).toBe("2025-01-02T03:04:05.000Z")
  })

  test("stored for listed keys; a cost-row-only key keeps the stored date", async () => {
    const db = seed()
    await applyOpenAIKeySync(asClient(db), OA, { keys: [key("k1", { created_at: "2025-01-02T03:04:05.000Z" })], projects: [{ id: "proj_1", name: "P" }] })
    expect(keyRow(db, OA, "k1")).toMatchObject({ provider_created_at: "2025-01-02T03:04:05.000Z", owner_person_id: "p-alice" })
    // Seen again only on cost rows (no date): unchanged.
    await applyOpenAIKeySync(asClient(db), OA, { keys: [key("k1", { source: "cost_records" })], projects: null })
    expect(keyRow(db, OA, "k1").provider_created_at).toBe("2025-01-02T03:04:05.000Z")
    // A corrected date is written.
    await applyOpenAIKeySync(asClient(db), OA, { keys: [key("k1", { created_at: "2025-01-03T00:00:00.000Z" })], projects: null })
    expect(keyRow(db, OA, "k1").provider_created_at).toBe("2025-01-03T00:00:00.000Z")
  })

  test("before migration 018 the date is neither read nor written", async () => {
    const db = seed()
    const s = await applyOpenAIKeySync(without018(db), OA, { keys: [key("k1", { created_at: "2025-01-02T03:04:05.000Z" })], projects: null })
    expect(s.created).toBe(1)
    expect(keyRow(db, OA, "k1")).not.toHaveProperty("provider_created_at")
  })
})

describe("Vercel AI Gateway: createdAt (epoch ms) -> provider_created_at", () => {
  test("the key list reads createdAt when present", async () => {
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname === "/v1/api-keys")
        return res({ apiKeys: [{ id: "gw_1", name: "one", createdAt: 1735787045000, createdBy: "uid_a" }, { id: "gw_2", name: "two" }], pagination: { next: null } })
      throw new Error(`unexpected ${u}`)
    }) as any
    const keys = await listGatewayKeysWithProjects("test-token", "team_x", { strict: true })
    expect(keys.find((k) => k.id === "gw_1")?.createdAt).toBe("2025-01-02T03:04:05.000Z")
    expect(keys.find((k) => k.id === "gw_2")).not.toHaveProperty("createdAt")
  })

  test("stored on insert, kept when a later listing omits it", async () => {
    const db = seed()
    const members = new Map([["uid_a", { email: "alice@liatrio.com", name: "Alice" }]])
    const k: GatewayKey = { id: "gw_1", name: "one", createdBy: "uid_a", createdAt: "2025-01-02T03:04:05.000Z" }
    await applyGatewayKeySync(asClient(db), GW, [k], members)
    expect(keyRow(db, GW, "gw_1")).toMatchObject({ provider_created_at: "2025-01-02T03:04:05.000Z", owner_person_id: "p-alice" })
    const again = await applyGatewayKeySync(asClient(db), GW, [{ ...k, createdAt: undefined }], members)
    expect(again.keys_unchanged).toBe(1)
    expect(keyRow(db, GW, "gw_1").provider_created_at).toBe("2025-01-02T03:04:05.000Z")
  })

  test("before migration 018 the date is neither read nor written", async () => {
    const db = seed()
    const members = new Map([["uid_a", { email: "alice@liatrio.com", name: "Alice" }]])
    const s = await applyGatewayKeySync(without018(db), GW, [{ id: "gw_1", createdBy: "uid_a", createdAt: "2025-01-02T03:04:05.000Z" }], members)
    expect(s.keys_inserted).toBe(1)
    expect(keyRow(db, GW, "gw_1")).not.toHaveProperty("provider_created_at")
  })
})
