/**
 * Runner idempotency with several attributed rows per bucket (no network, no
 * database: an in-memory fake of the few Supabase calls storeRecords makes).
 */

jest.mock("@/lib/supabase/admin", () => ({
  createAdminClient: jest.fn(),
  touchProvidersCollected: jest.fn(),
}))

import type { SupabaseClient } from "@supabase/supabase-js"
import { storeRecords } from "./runner"
import type { CostRecord } from "./types"

type Row = CostRecord & { id: number }

/** Minimal fake: from().delete().eq()...in() and from().insert().select(). */
function fakeAdmin(rows: Row[]) {
  let nextId = rows.length + 1
  const client = {
    from(table: string) {
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

describe("runPostCollectSync (issue #24)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runPostCollectSync, POST_COLLECT_SYNC } = require("./runner") as typeof import("./runner")
  const admin = {} as SupabaseClient

  test("providers without a sync, and the gateway without VERCEL_TOKEN, report nothing", async () => {
    expect(await runPostCollectSync("anthropic", admin, { providerId: "p" })).toBeUndefined()
    expect(await runPostCollectSync("vercel-ai-gateway", admin, { providerId: "p" })).toBeUndefined()
  })

  test("a failing sync is reported, never thrown", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const original = POST_COLLECT_SYNC["vercel-ai-gateway"]
    POST_COLLECT_SYNC["vercel-ai-gateway"] = async () => {
      throw new Error("Failed to read org_api_keys: column does not exist")
    }
    try {
      await expect(runPostCollectSync("vercel-ai-gateway", admin, { providerId: "p", auxApiKey: "t" })).resolves.toEqual({
        status: "error",
        error: "Failed to read org_api_keys: column does not exist",
      })
    } finally {
      POST_COLLECT_SYNC["vercel-ai-gateway"] = original
      warn.mockRestore()
    }
  })
})
