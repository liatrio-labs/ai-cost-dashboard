/**
 * Runner idempotency with several attributed rows per bucket (no network, no
 * database: an in-memory fake of the few Supabase calls storeRecords makes).
 */

jest.mock("@/lib/supabase/admin", () => ({
  createAdminClient: jest.fn(),
  touchProvidersCollected: jest.fn(),
}))

import type { SupabaseClient } from "@supabase/supabase-js"
import { createAdminClient } from "@/lib/supabase/admin"
import { storeRecords, runCollectionForProvider } from "./runner"
import { collector as anthropic } from "./anthropic"
import type { CostRecord } from "./types"

type Row = CostRecord & { id: number }

/**
 * Minimal fake: from().delete().eq()...in() and from().insert().select() on
 * cost_records, plus from("providers").select().eq().single() for the runner.
 */
function fakeAdmin(rows: Row[]) {
  let nextId = rows.length + 1
  const client = {
    from(table: string) {
      if (table === "providers") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          single: () => Promise.resolve({ data: { id: "prov" }, error: null }),
        }
        return chain
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
              filters.push((r) => vals.includes(r[col]))
              const keep = rows.filter((r) => !filters.every((f) => f(r)))
              rows.splice(0, rows.length, ...keep)
              return Promise.resolve({ error: null })
            },
          }
          return chain
        },
        insert(newRows: CostRecord[]) {
          const inserted = newRows.map((r) => ({ ...r, id: nextId++ }))
          rows.push(...inserted)
          return {
            select: () => Promise.resolve({ data: inserted.map((r) => ({ id: r.id })), error: null }),
          }
        },
      }
    },
  }
  return client as unknown as SupabaseClient
}

function rec(timestamp: string, cost: number, attribution: Record<string, unknown>): CostRecord {
  return {
    user_id: "owner",
    provider_id: "prov",
    timestamp,
    model_name: "m",
    cost_usd: cost,
    tokens_used: null,
    input_tokens: null,
    output_tokens: null,
    request_count: 1,
    collection_method: "api_automated",
    metadata: { attribution },
  }
}

const D1 = "2026-10-01T00:00:00.000Z"
const D2 = "2026-10-02T00:00:00.000Z"

function windowRecords(): CostRecord[] {
  return [
    rec(D1, 1, { granularity: "person", person_email: "a@x.com" }),
    rec(D1, 2, { granularity: "api_key", api_key_id: "k1" }),
    rec(D1, 3, { granularity: "org" }),
    rec(D2, 4, { granularity: "person", person_email: "a@x.com" }),
    rec(D2, 5, { granularity: "org" }),
  ]
}

describe("storeRecords idempotency", () => {
  test("re-running a window replaces every attributed row instead of duplicating", async () => {
    const manual = { ...rec(D1, 100, { granularity: "org" }), collection_method: "manual_entry", id: 0 } as unknown as Row
    const otherProvider = { ...rec(D1, 50, { granularity: "org" }), provider_id: "other", id: -1 } as Row
    const rows: Row[] = [manual, otherProvider]
    const admin = fakeAdmin(rows)

    await storeRecords(admin, windowRecords())
    await storeRecords(admin, windowRecords())

    const ours = rows.filter((r) => r.provider_id === "prov" && r.collection_method === "api_automated")
    expect(ours).toHaveLength(5)
    expect(ours.reduce((s, r) => s + r.cost_usd, 0)).toBe(15)
    // Untouched: manual rows and other providers at the same timestamp.
    expect(rows).toContain(manual)
    expect(rows).toContain(otherProvider)
  })

  test("a re-pull whose attribution changed leaves no stale rows behind", async () => {
    const rows: Row[] = []
    const admin = fakeAdmin(rows)
    await storeRecords(admin, windowRecords())

    // Same D1 bucket, now attributed differently (e.g. a late revision).
    await storeRecords(admin, [rec(D1, 6, { granularity: "workspace", workspace_id: "w1" })])

    const d1 = rows.filter((r) => r.timestamp === D1)
    expect(d1).toHaveLength(1)
    expect(d1[0].cost_usd).toBe(6)
    expect(rows.filter((r) => r.timestamp === D2)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// #21: re-fetched days overwrite revised values (higher or lower)
// ---------------------------------------------------------------------------

type Stored = Pick<Row, "timestamp" | "cost_usd" | "collection_method" | "provider_id">
function day(rows: Stored[], ts: string) {
  const r = rows.filter((x) => x.timestamp === ts && x.provider_id === "prov" && x.collection_method === "api_automated")
  return { count: r.length, sum: Math.round(r.reduce((s, x) => s + x.cost_usd, 0) * 1e6) / 1e6 }
}

describe("storeRecords overwrites revised days (#21)", () => {
  test("revised higher and lower values for overlapping days leave exactly the new rows", async () => {
    const rows: Row[] = []
    const admin = fakeAdmin(rows)
    // Run 1: early capture.
    await storeRecords(admin, windowRecords()) // D1: 3 rows / 6, D2: 2 rows / 9

    // Run 2: the next daily window overlaps both days. D1 settled higher (and
    // gained a row), D2 was revised lower (and lost a row).
    await storeRecords(admin, [
      rec(D1, 1.5, { granularity: "person", person_email: "a@x.com" }),
      rec(D1, 2.5, { granularity: "api_key", api_key_id: "k1" }),
      rec(D1, 3.25, { granularity: "org" }),
      rec(D1, 4, { granularity: "person", person_email: "b@x.com" }),
      rec(D2, 7.75, { granularity: "org" }),
    ])

    expect(day(rows, D1)).toEqual({ count: 4, sum: 11.25 })
    expect(day(rows, D2)).toEqual({ count: 1, sum: 7.75 })
    expect(rows).toHaveLength(5)
  })

  test("replaces an old org-level Anthropic row (model 'unknown', no attribution) and leaves manual/CSV rows alone", async () => {
    // Today's daily window through the real collector (mocked fetch), so the
    // timestamps are exactly what anthropic emits for a re-fetched day.
    const now = new Date("2026-11-03T15:30:00Z")
    jest.useFakeTimers({ now, doNotFake: ["setTimeout", "clearTimeout", "setImmediate", "nextTick", "queueMicrotask"] })
    const DAY_TS = "2026-10-30T00:00:00.000Z" // inside [today - 7d, tomorrow)
    const NEXT = "2026-10-31T00:00:00Z"

    const legacyOrgRow = {
      ...rec(DAY_TS, 900, {}),
      model_name: "unknown",
      metadata: { provider: "anthropic", bucket_width: "1d" }, // pre-attribution shape
      id: 1,
    } as Row
    const manual = { ...rec(DAY_TS, 100, {}), collection_method: "manual_entry", id: 2 } as unknown as Row
    const csv = { ...rec(DAY_TS, 50, {}), collection_method: "csv_import", id: 3 } as unknown as Row
    const rows: Row[] = [legacyOrgRow, manual, csv]
    const admin = fakeAdmin(rows)

    const realFetch = global.fetch
    const pull = async (cents: string[]) => {
      global.fetch = jest.fn(async (url: unknown) => {
        const u = new URL(String(url))
        const data = u.pathname.endsWith("/analytics/cost")
          ? cents.map((amount, i) => ({
              starting_at: "2026-10-30T00:00:00Z",
              ending_at: NEXT,
              group: { actor: { type: "api_actor", api_key_id: `apikey_${i}` }, api_key_id: `apikey_${i}`, workspace_id: null, model: "claude-sonnet-4-5" },
              cost: { amount, currency: "USD", requests: 1 },
            }))
          : []
        return { ok: true, status: 200, json: async () => ({ data, has_more: false, next_page: null }) } as unknown as Response
      }) as unknown as typeof fetch
      const records = await anthropic.collect({ apiKey: "test-key", userId: "owner", providerId: "prov" })
      return storeRecords(admin, records)
    }

    try {
      // First attributed pull: two key rows (cents) = $950 replaces the $900 org row.
      await pull(["60000", "35000"])
      expect(rows).not.toContain(legacyOrgRow)
      expect(day(rows, DAY_TS)).toEqual({ count: 2, sum: 950 })

      // Next day's run re-fetches the same day, revised lower: exactly the new values.
      await pull(["80000"])
      expect(day(rows, DAY_TS)).toEqual({ count: 1, sum: 800 })

      // Identical re-run: no change in count or sum.
      await pull(["80000"])
      expect(day(rows, DAY_TS)).toEqual({ count: 1, sum: 800 })

      // Manual and CSV rows at the same timestamp are untouched.
      expect(rows).toContain(manual)
      expect(rows).toContain(csv)
      expect(rows.filter((r) => r.model_name === "unknown")).toHaveLength(0)
    } finally {
      global.fetch = realFetch
      jest.useRealTimers()
    }
  })
})

describe("runCollectionForProvider details (#21)", () => {
  const savedEnv = { ...process.env }
  const realFetch = global.fetch
  afterEach(() => {
    process.env = { ...savedEnv }
    global.fetch = realFetch
    jest.restoreAllMocks()
  })

  test("surfaces the OpenAI costs grouping flag in the summary", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {})
    process.env.OPENAI_ADMIN_KEY = "test-openai-key"
    process.env.DASHBOARD_OWNER_USER_ID = "owner"
    const rows: Row[] = []
    ;(createAdminClient as jest.Mock).mockReturnValue(fakeAdmin(rows))
    global.fetch = jest.fn(async (url: unknown) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith("/costs") && u.searchParams.getAll("group_by").includes("api_key_id")) {
        return { ok: false, status: 400, json: async () => ({}), text: async () => "bad group_by" } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ data: [], has_more: false }), text: async () => "" } as unknown as Response
    }) as unknown as typeof fetch

    const summary = await runCollectionForProvider("openai")
    expect(summary.status).toBe("success")
    expect(summary.details).toEqual({ costs_grouping: "fallback" })
    expect(JSON.stringify(summary)).not.toContain("test-openai-key")
  })

  test("omits details for collectors that report none", async () => {
    process.env.ANTHROPIC_ADMIN_KEY = "test-anthropic-key"
    process.env.DASHBOARD_OWNER_USER_ID = "owner"
    ;(createAdminClient as jest.Mock).mockReturnValue(fakeAdmin([]))
    global.fetch = jest.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ data: [], has_more: false, next_page: null }) }) as unknown as Response
    ) as unknown as typeof fetch
    const summary = await runCollectionForProvider("anthropic")
    expect(summary.status).toBe("success")
    expect(summary).not.toHaveProperty("details")
  })
})
