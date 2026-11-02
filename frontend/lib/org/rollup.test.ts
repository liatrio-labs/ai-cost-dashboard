import { buildOrgIndex } from "./attribution"
import { D, K, P, PE, T, orgData } from "./test-fixtures"
import {
  ROLLUP_LEVELS,
  UNASSIGNED_KEY,
  UNASSIGNED_LABEL,
  rollup,
  rollupAll,
  toAttributedDailyRows,
  totalOf,
  type CostRecordLike,
} from "./rollup"
import type { AttributedDailyRow } from "./types"

const index = buildOrgIndex(orgData())

/** Same cases as scripts/migration-tests/fixtures.sql. */
const rec = (provider_id: string, timestamp: string, model_name: string, cost_usd: number, metadata: unknown): CostRecordLike => ({
  provider_id,
  timestamp,
  model_name,
  cost_usd,
  tokens_used: 100,
  input_tokens: 60,
  output_tokens: 40,
  request_count: 1,
  metadata: metadata as CostRecordLike["metadata"],
})

const RECORDS: CostRecordLike[] = [
  rec(P.anthropic, "2026-11-01T10:00:00Z", "a_email", 1, { attribution: { person_email: "ALICE@liatrio.com", granularity: "person" } }),
  rec(P.openai, "2026-11-01T11:00:00Z", "b_key_owner", 2, { attribution: { api_key_id: "key_owner", granularity: "api_key" } }),
  rec(P.openai, "2026-11-01T12:00:00Z", "b_key_team", 4, { attribution: { api_key_id: "key_team", granularity: "api_key" } }),
  rec(P.openai, "2026-11-01T13:00:00Z", "c_key_beats_person", 8, { attribution: { person_email: "bob@liatrio.com", api_key_id: "key_team", granularity: "api_key" } }),
  rec(P.openai, "2026-11-01T14:00:00Z", "d_none", 16, {}),
  rec(P.openai, "2026-11-01T15:00:00Z", "d_none", 32, { member_email: "bob@liatrio.com" }),
  rec(P.cursor, "2026-11-02T09:00:00Z", "d_none", 64, null),
  rec(P.anthropic, "2026-11-02T10:00:00Z", "ext_id", 128, { attribution: { person_external_id: "user_bob", granularity: "person" } }),
  rec(P.cursor, "2026-11-02T11:00:00Z", "email_identity", 256, { attribution: { person_email: "dave.alias@liatrio.com", granularity: "person" } }),
  rec(P.anthropic, "2026-11-02T12:00:00Z", "email_beats_ext", 512, { attribution: { person_email: "alice@liatrio.com", person_external_id: "user_bob", granularity: "person" } }),
  rec(P.anthropic, "2026-11-02T13:00:00Z", "person_no_team", 0.5, { attribution: { person_email: "carol@liatrio.com", granularity: "person" } }),
  rec(P.anthropic, "2026-11-02T14:00:00Z", "team_no_dept", 0.25, { attribution: { person_email: "erin@liatrio.com", granularity: "person" } }),
  rec(P.openai, "2026-11-02T15:00:00Z", "unknown", 0.125, { attribution: { person_email: "ghost@example.com", api_key_id: "key_missing", granularity: "api_key" } }),
  rec(P.openai, "2026-11-02T16:00:00Z", "key_bare", 3, { attribution: { api_key_id: "key_bare", project_id: "proj_1", granularity: "project" } }),
  rec(P.anthropic, "2026-11-02T17:00:00Z", "key_wrong_provider", 5, { attribution: { api_key_id: "key_team", workspace_id: "wrk_1", granularity: "workspace" } }),
  rec(P.openai, "2026-11-02T18:00:00Z", "empty_strings", 7, { attribution: { person_email: "", api_key_id: "", granularity: "bogus" } }),
]
const INPUT_TOTAL = RECORDS.reduce((s, r) => s + Number(r.cost_usd), 0)
const ROWS = toAttributedDailyRows(RECORDS, index)

const bucket = (level: Parameters<typeof rollup>[1], key: string) =>
  rollup(ROWS, level, index).find((b) => b.key === key)

describe("toAttributedDailyRows", () => {
  it("groups by date/provider/model/attribution like the SQL view", () => {
    // 16 records, the two openai d_none rows on 2026-11-01 share one group.
    expect(ROWS).toHaveLength(15)
    const dNone = ROWS.find((r) => r.model_name === "d_none" && r.provider_id === P.openai)
    expect(dNone).toMatchObject({ date: "2026-11-01", record_count: 2, total_cost_usd: 48, total_tokens: 200, total_requests: 2 })
  })

  it("preserves the input total", () => {
    expect(totalOf(ROWS).total_cost_usd).toBeCloseTo(INPUT_TOTAL, 6)
    expect(totalOf(ROWS).record_count).toBe(RECORDS.length)
  })
})

describe("rollup", () => {
  it.each(ROLLUP_LEVELS)("%s buckets (including Unassigned) sum to the input total", (level) => {
    const buckets = rollup(ROWS, level, index)
    const sum = buckets.reduce((s, b) => s + b.total_cost_usd, 0)
    expect(sum).toBeCloseTo(INPUT_TOTAL, 6)
    expect(buckets.reduce((s, b) => s + b.record_count, 0)).toBe(RECORDS.length)
    expect(buckets.reduce((s, b) => s + b.total_tokens, 0)).toBe(RECORDS.length * 100)
  })

  it.each(ROLLUP_LEVELS)("%s has exactly one Unassigned bucket, last", (level) => {
    const buckets = rollup(ROWS, level, index)
    const unassigned = buckets.filter((b) => b.unassigned)
    expect(unassigned).toHaveLength(1)
    expect(buckets[buckets.length - 1]).toMatchObject({ key: UNASSIGNED_KEY, id: null, label: UNASSIGNED_LABEL })
  })

  it("department totals", () => {
    // Eng: a_email 1 + b_key_team 4 + c 8 + email_identity 256 + email_beats_ext 512
    expect(bucket("department", D.eng)).toMatchObject({ label: "Engineering", total_cost_usd: 781 })
    // Sales: b_key_owner 2 + ext_id 128
    expect(bucket("department", D.sales)).toMatchObject({ label: "Sales", total_cost_usd: 130 })
    // Unassigned: d_none 112 + carol 0.5 + erin (no dept) 0.25 + unknown 0.125 + key_bare 3 + wrong provider 5 + empty 7
    expect(bucket("department", UNASSIGNED_KEY)?.total_cost_usd).toBeCloseTo(127.875, 6)
  })

  it("team totals: key team beats person team, team without department still counts", () => {
    expect(bucket("team", T.data)).toMatchObject({ label: "Data", total_cost_usd: 4 + 8 + 256 })
    expect(bucket("team", T.platform)).toMatchObject({ total_cost_usd: 1 + 512 })
    expect(bucket("team", T.field)).toMatchObject({ total_cost_usd: 2 + 128 })
    expect(bucket("team", T.orphan)).toMatchObject({ label: "Orphan", total_cost_usd: 0.25 })
  })

  it("person totals and labels (display name, else email)", () => {
    expect(bucket("person", PE.alice)).toMatchObject({ label: "Alice", total_cost_usd: 1 + 4 + 512 })
    expect(bucket("person", PE.bob)).toMatchObject({ label: "Bob", total_cost_usd: 2 + 8 + 128 })
    expect(bucket("person", PE.carol)).toMatchObject({ label: "carol@liatrio.com", total_cost_usd: 0.5 })
  })

  it("API key totals and labels (name, else external id)", () => {
    expect(bucket("api_key", K.team)).toMatchObject({ label: "Data pipeline key", total_cost_usd: 12 })
    expect(bucket("api_key", K.owner)).toMatchObject({ label: "key_owner", total_cost_usd: 2 })
    expect(bucket("api_key", K.bare)).toMatchObject({ label: "Unowned key", total_cost_usd: 3 })
  })

  it("sorts assigned buckets by cost descending", () => {
    const costs = rollup(ROWS, "person", index).filter((b) => !b.unassigned).map((b) => b.total_cost_usd)
    expect(costs).toEqual([...costs].sort((a, b) => b - a))
  })

  it("falls back to ids as labels without an index", () => {
    expect(rollup(ROWS, "team").find((b) => b.key === T.data)?.label).toBe(T.data)
  })

  it("accepts numeric strings from PostgREST and ignores garbage", () => {
    const rows: AttributedDailyRow[] = [
      { date: "2026-11-01", provider_id: P.openai, model_name: "m", person_id: PE.alice, org_api_key_id: null, team_id: T.platform, department_id: D.eng, project_id: null, workspace_id: null, granularity: "person", total_cost_usd: "1.100000", total_tokens: "10", total_requests: null, record_count: "1" },
      { date: "2026-11-01", provider_id: P.openai, model_name: "m", person_id: null, org_api_key_id: null, team_id: null, department_id: null, project_id: null, workspace_id: null, granularity: "org", total_cost_usd: "2.200000", total_tokens: "n/a", record_count: 1 },
    ]
    const out = rollupAll(rows, index)
    expect(out.total).toEqual({ total_cost_usd: 3.3, total_tokens: 10, total_requests: 0, record_count: 2 })
    expect(out.department.map((b) => [b.key, b.total_cost_usd])).toEqual([[D.eng, 1.1], [UNASSIGNED_KEY, 2.2]])
  })

  it("empty input still yields a $0 Unassigned bucket at every level", () => {
    const out = rollupAll([], index)
    expect(out.total.total_cost_usd).toBe(0)
    for (const level of ROLLUP_LEVELS) {
      expect(out[level]).toEqual([
        { key: UNASSIGNED_KEY, id: null, label: UNASSIGNED_LABEL, unassigned: true, total_cost_usd: 0, total_tokens: 0, total_requests: 0, record_count: 0 },
      ])
    }
  })
})

describe("rollupAll", () => {
  it("every level reconciles with the total", () => {
    const out = rollupAll(ROWS, index)
    expect(out.total.total_cost_usd).toBeCloseTo(INPUT_TOTAL, 6)
    for (const level of ROLLUP_LEVELS) {
      expect(out[level].reduce((s, b) => s + b.total_cost_usd, 0)).toBeCloseTo(out.total.total_cost_usd, 6)
    }
  })
})
