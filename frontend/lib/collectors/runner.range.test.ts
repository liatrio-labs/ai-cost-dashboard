/* eslint-disable @typescript-eslint/no-explicit-any -- mocked provider JSON */
/**
 * Explicit-range re-pulls through runCollectionForProvider (issue #20).
 *
 * In-memory fake of the Supabase calls the runner makes, mocked provider
 * fetch, no network, no database. Proves the superseding/idempotency rules
 * documented on storeRecords().
 */

const mockDb: { client: unknown } = { client: null }
jest.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockDb.client,
  touchProvidersCollected: jest.fn(async () => undefined),
}))

import { runCollectionForProvider } from "./runner"
import type { CostRecord } from "./types"

type Row = CostRecord & { id: number }

const PROVIDER_ID = "prov-anthropic"
const OWNER = "owner-1"

/** Fake: providers lookup, cost_records delete().eq()...in() and insert().select(). */
function fakeAdmin(rows: Row[], stats = { deletes: 0, inserts: 0 }) {
  let nextId = 1000
  const client = {
    from(table: string) {
      if (table === "providers") {
        return {
          select: () => ({
            eq: (_c: string, name: string) => ({
              single: async () => ({ data: { id: `prov-${name}` }, error: null }),
            }),
          }),
        }
      }
      if (table !== "cost_records") throw new Error(`unexpected table ${table}`)
      return {
        delete() {
          const filters: Array<(r: Row) => boolean> = []
          const chain = {
            eq(col: keyof Row, val: unknown) {
              filters.push((r) => r[col] === val)
              return chain
            },
            in(col: keyof Row, vals: unknown[]) {
              stats.deletes++
              filters.push((r) => vals.includes(r[col]))
              const keep = rows.filter((r) => !filters.every((f) => f(r)))
              rows.splice(0, rows.length, ...keep)
              return Promise.resolve({ error: null })
            },
          }
          return chain
        },
        insert(newRows: CostRecord[]) {
          stats.inserts++
          const inserted = newRows.map((r) => ({ ...r, id: nextId++ }))
          rows.push(...inserted)
          return { select: () => Promise.resolve({ data: inserted.map((r) => ({ id: r.id })), error: null }) }
        },
      }
    },
  }
  return client
}

const D = (day: string) => `2026-${day}T00:00:00.000Z`

/** The shape historic Anthropic rows have: org-level, model 'unknown', no attribution. */
function oldOrgRow(id: number, day: string, cost: number): Row {
  return {
    id,
    user_id: OWNER,
    provider_id: PROVIDER_ID,
    timestamp: D(day),
    model_name: "unknown",
    cost_usd: cost,
    tokens_used: 0,
    input_tokens: 0,
    output_tokens: 0,
    request_count: 1,
    collection_method: "api_automated",
    metadata: { provider: "anthropic", bucket_width: "1d" },
  }
}

function manualRow(id: number, day: string, cost: number, method = "manual_entry"): Row {
  return { ...oldOrgRow(id, day, cost), model_name: "manual", collection_method: method as any }
}

/** Analytics cost rows for one day: a person, an API key and a default-workspace remainder. */
function analyticsCostRows(day: string, cents: [number, number, number]) {
  const starting_at = `2026-${day}T00:00:00Z`
  const base = { starting_at, ending_at: starting_at }
  return [
    {
      ...base,
      group: {
        actor: { type: "user_actor", user_id: "u1", email_address: "Ada@Example.com", name: "Ada" },
        api_key_id: null,
        workspace_id: "wrkspc_1",
        model: "claude-sonnet-4-5",
      },
      cost: { amount: String(cents[0]) },
    },
    {
      ...base,
      group: { actor: { type: "api_actor", api_key_id: "apikey_1" }, api_key_id: "apikey_1", workspace_id: null, model: "claude-haiku-4-5" },
      cost: { amount: String(cents[1]) },
    },
    { ...base, group: { actor: null, api_key_id: null, workspace_id: null, model: "claude-opus-4-1" }, cost: { amount: String(cents[2]) } },
  ]
}

const res = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

/** Mock the analytics API: `/cost` serves `costRows` filtered to the requested window. */
function mockAnalytics(costRows: any[], opts: { failUsage?: boolean; failKeySync?: boolean } = {}) {
  global.fetch = jest.fn(async (url: any) => {
    const u = new URL(String(url))
    // Issue #32: the Anthropic key sync runs after collection (no keys here).
    if (/\/organizations\/(api_keys|users|workspaces)$/.test(u.pathname)) {
      if (opts.failKeySync) return res({ error: { type: "permission_error" } }, 403)
      return res({ data: [], has_more: false })
    }
    const lo = Date.parse(u.searchParams.get("starting_at")!)
    const hi = Date.parse(u.searchParams.get("ending_at")!)
    if (u.pathname.endsWith("/analytics/cost")) {
      const data = costRows.filter((r) => Date.parse(r.starting_at) >= lo && Date.parse(r.starting_at) < hi)
      return res({ data, has_more: false, next_page: null })
    }
    if (u.pathname.endsWith("/analytics/usage")) {
      if (opts.failUsage) return res({ error: { type: "invalid_request_error" } }, 400)
      return res({ data: [], has_more: false, next_page: null })
    }
    throw new Error(`unexpected ${url}`)
  }) as any
}

const RANGE = { start: new Date(D("07-22")), end: new Date(D("07-25")) } // 07-22..07-24 inclusive

const sum = (rows: Row[]) => Math.round(rows.reduce((s, r) => s + r.cost_usd, 0) * 100) / 100
const auto = (rows: Row[], day?: string) =>
  rows.filter(
    (r) =>
      r.provider_id === PROVIDER_ID &&
      r.collection_method === "api_automated" &&
      (day === undefined || r.timestamp === D(day))
  )

describe("runCollectionForProvider with an explicit range", () => {
  const realFetch = global.fetch
  const saved = { key: process.env.ANTHROPIC_ADMIN_KEY, owner: process.env.DASHBOARD_OWNER_USER_ID }
  beforeEach(() => {
    process.env.ANTHROPIC_ADMIN_KEY = "test-admin-key"
    process.env.DASHBOARD_OWNER_USER_ID = OWNER
  })
  afterEach(() => {
    global.fetch = realFetch
    if (saved.key === undefined) delete process.env.ANTHROPIC_ADMIN_KEY
    else process.env.ANTHROPIC_ADMIN_KEY = saved.key
    if (saved.owner === undefined) delete process.env.DASHBOARD_OWNER_USER_ID
    else process.env.DASHBOARD_OWNER_USER_ID = saved.owner
    jest.restoreAllMocks()
  })

  function seed(): Row[] {
    return [
      oldOrgRow(1, "07-21", 999), // outside the range: untouched
      oldOrgRow(2, "07-22", 400), // re-pulled: replaced
      // 07-23 has no row (known gap) and comes back with data.
      oldOrgRow(3, "07-24", 300), // provider returns nothing: left alone
      oldOrgRow(4, "07-25", 999), // outside the range: untouched
      manualRow(5, "07-22", 50),
      manualRow(6, "07-22", 25, "csv_import"),
    ]
  }

  // 07-22: $1.50 + $2.25 + $0.75 = $4.50; 07-23: $1 + $2 + $3 = $6.
  const provider = [...analyticsCostRows("07-22", [150, 225, 75]), ...analyticsCostRows("07-23", [100, 200, 300])]

  test("an old org-level 'unknown' row is replaced by the attributed rows, not added to", async () => {
    const rows = seed()
    mockDb.client = fakeAdmin(rows)
    mockAnalytics(provider)

    const result = await runCollectionForProvider("anthropic", { range: RANGE })
    expect(result.status).toBe("success")
    expect(result.records_stored).toBe(6)

    const d22 = auto(rows, "07-22")
    expect(d22).toHaveLength(3)
    expect(d22.some((r) => r.model_name === "unknown")).toBe(false)
    expect(d22.every((r) => (r.metadata as any).attribution)).toBe(true)
    // Per-day total == new attributed rows' total (old $400 is gone, not added).
    expect(sum(d22)).toBe(4.5)
    expect(sum(auto(rows, "07-23"))).toBe(6)

    expect(result.days).toEqual([
      { date: "2026-07-22", records: 3, cost_usd: 4.5 },
      { date: "2026-07-23", records: 3, cost_usd: 6 },
      { date: "2026-07-24", records: 0, cost_usd: 0 },
    ])
  })

  test("issue #32: collection still succeeds when the Anthropic key sync fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const rows = seed()
    mockDb.client = fakeAdmin(rows)
    mockAnalytics(provider, { failKeySync: true })
    const result = await runCollectionForProvider("anthropic", { range: RANGE })
    expect(result.status).toBe("success")
    expect(result.records_stored).toBe(6)
    expect(result.key_sync).toMatchObject({ status: "error", error: expect.stringMatching(/api_keys failed: HTTP 403/) })
    expect(JSON.stringify(result)).not.toMatch(/test-admin-key/)
    expect(warn).toHaveBeenCalled()
  })

  test("issue #32: a successful collection reports the Anthropic key sync as key_sync", async () => {
    mockDb.client = fakeAdmin(seed())
    mockAnalytics(provider)
    const result = await runCollectionForProvider("anthropic", { range: RANGE })
    expect(result.status).toBe("success")
    expect(result.key_sync).toMatchObject({ status: "success", keys_listed: 0, created: 0 })
  })

  test("in-range days with no buckets, out-of-range days and manual/CSV rows are untouched", async () => {
    const rows = seed()
    mockDb.client = fakeAdmin(rows)
    mockAnalytics(provider)
    await runCollectionForProvider("anthropic", { range: RANGE })

    const ids = rows.map((r) => r.id)
    for (const id of [1, 3, 4, 5, 6]) expect(ids).toContain(id)
    expect(auto(rows, "07-24")).toEqual([oldOrgRow(3, "07-24", 300)])
    expect(rows.filter((r) => r.collection_method !== "api_automated").map((r) => r.cost_usd).sort()).toEqual([25, 50])
  })

  test("a second identical run changes neither the row count nor SUM(cost_usd)", async () => {
    const rows = seed()
    mockDb.client = fakeAdmin(rows)
    mockAnalytics(provider)

    await runCollectionForProvider("anthropic", { range: RANGE })
    const count1 = rows.length
    const sum1 = sum(rows)
    const auto1 = auto(rows).length

    await runCollectionForProvider("anthropic", { range: RANGE })
    expect(rows.length).toBe(count1)
    expect(sum(rows)).toBe(sum1)
    expect(auto(rows).length).toBe(auto1)
    // 999 + 4.5 + 6 + 300 + 999 + 50 + 25
    expect(sum1).toBe(2383.5)
  })

  test("records the provider returns outside the range are not stored (no out-of-range deletes)", async () => {
    const rows = seed()
    mockDb.client = fakeAdmin(rows)
    // A misbehaving API that ignores the window and returns 07-21 too.
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith("/analytics/cost")) {
        return res({ data: [...analyticsCostRows("07-21", [1, 1, 1]), ...analyticsCostRows("07-22", [150, 225, 75])], has_more: false })
      }
      return res({ data: [], has_more: false })
    }) as any

    const result = await runCollectionForProvider("anthropic", { range: RANGE })
    expect(result.records_collected).toBe(6)
    expect(result.records_stored).toBe(3)
    expect(auto(rows, "07-21")).toEqual([oldOrgRow(1, "07-21", 999)])
  })

  test("nothing is deleted or inserted when any fetch in the chunk fails", async () => {
    const rows = seed()
    const before = JSON.parse(JSON.stringify(rows))
    const stats = { deletes: 0, inserts: 0 }
    mockDb.client = fakeAdmin(rows, stats)
    // /cost succeeds, /usage fails (non-retryable 400) for the same chunk.
    mockAnalytics(provider, { failUsage: true })

    const result = await runCollectionForProvider("anthropic", { range: RANGE })
    expect(result.status).toBe("error")
    expect(result.error).toMatch(/400/)
    expect(stats).toEqual({ deletes: 0, inserts: 0 })
    expect(rows).toEqual(before)
  })

  test("nothing is deleted when a later page of a multi-page fetch fails mid-range", async () => {
    const rows = seed()
    const before = JSON.parse(JSON.stringify(rows))
    const stats = { deletes: 0, inserts: 0 }
    mockDb.client = fakeAdmin(rows, stats)
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn()
      return 0
    }) as any)
    global.fetch = jest.fn(async (url: any) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith("/analytics/cost")) {
        if (!u.searchParams.get("page")) {
          return res({ data: analyticsCostRows("07-22", [150, 225, 75]), has_more: true, next_page: "p2" })
        }
        return res({ error: { type: "invalid_request_error" } }, 400)
      }
      return res({ data: [], has_more: false })
    }) as any

    const result = await runCollectionForProvider("anthropic", { range: RANGE })
    expect(result.status).toBe("error")
    expect(stats).toEqual({ deletes: 0, inserts: 0 })
    expect(rows).toEqual(before)
  })

  test("without a range the summary has no per-day breakdown (cron output unchanged)", async () => {
    mockDb.client = fakeAdmin([])
    mockAnalytics([])
    const result = await runCollectionForProvider("anthropic")
    expect(result.status).toBe("success")
    expect(result.days).toBeUndefined()
  })
})
