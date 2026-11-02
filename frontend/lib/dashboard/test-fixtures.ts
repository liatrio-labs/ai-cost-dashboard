/**
 * Jest fixtures for the dashboard and breakdown APIs (issue #8): cost records
 * across two months and four providers, attributed with the shared org
 * fixture from lib/org/test-fixtures.ts, plus a minimal Supabase mock.
 */

import { buildOrgIndex } from "@/lib/org/attribution"
import { toAttributedDailyRows, type CostRecordLike } from "@/lib/org/rollup"
import { orgData, P } from "@/lib/org/test-fixtures"
import type { AttributedDailyRow, OrgData } from "@/lib/org/types"

export const PROV = { ...P, windsurf: "prov-windsurf" }

export const providerRows = [
  { id: PROV.anthropic, name: "anthropic", display_name: "Anthropic API", documentation_url: "", last_collected_at: null, metadata: { collection_method: "api" } },
  { id: PROV.cursor, name: "cursor", display_name: "Cursor", documentation_url: "", last_collected_at: null, metadata: { collection_method: "api" } },
  { id: PROV.openai, name: "openai", display_name: "OpenAI API", documentation_url: "", last_collected_at: null, metadata: { collection_method: "api" } },
  { id: PROV.windsurf, name: "windsurf", display_name: "Windsurf", documentation_url: "", last_collected_at: null, metadata: { collection_method: "api" } },
]

const rec = (
  date: string,
  provider_id: string,
  model_name: string,
  cost_usd: number,
  attribution?: Record<string, unknown>,
  tokens_used = 1000
): CostRecordLike => ({
  timestamp: `${date}T12:00:00Z`,
  provider_id,
  model_name,
  cost_usd,
  tokens_used,
  request_count: 1,
  metadata: attribution ? { attribution } : {},
})

/** Nov 2026 total: 347. Oct 2026 total: 150. */
export const costRecords: CostRecordLike[] = [
  // ---- November 2026
  rec("2026-11-03", PROV.anthropic, "claude-opus", 100, { person_email: "Alice@Liatrio.com", granularity: "person" }),
  rec("2026-11-04", PROV.anthropic, "claude-sonnet", 40, { person_external_id: "user_bob", granularity: "person" }),
  rec("2026-11-04", PROV.anthropic, "claude-sonnet", 10), // pre-#6 row, no attribution
  rec("2026-11-05", PROV.openai, "gpt-5", 60, { api_key_id: "key_team", project_id: "proj_1", granularity: "api_key" }),
  rec("2026-11-05", PROV.openai, "gpt-5", 25, { api_key_id: "key_owner", granularity: "api_key" }),
  rec("2026-11-05", PROV.openai, "gpt-5", 5, { api_key_id: "key_bare", granularity: "api_key" }),
  rec("2026-11-05", PROV.openai, "gpt-5", 7, { api_key_id: "key_unknown", granularity: "api_key" }),
  rec("2026-11-06", PROV.cursor, "auto", 30, { person_email: "dave.alias@liatrio.com", granularity: "person" }),
  rec("2026-11-06", PROV.cursor, "auto", 12, { person_email: "carol@liatrio.com", granularity: "person" }),
  rec("2026-11-06", PROV.cursor, "auto", 8, { person_email: "erin@liatrio.com", granularity: "person" }),
  rec("2026-11-07", PROV.windsurf, "windsurf", 50, { granularity: "org" }),
  // ---- October 2026
  rec("2026-10-10", PROV.anthropic, "claude-opus", 50, { person_email: "alice@liatrio.com", granularity: "person" }),
  rec("2026-10-11", PROV.openai, "gpt-5", 30, { api_key_id: "key_team", granularity: "api_key" }),
  rec("2026-10-12", PROV.cursor, "auto", 20, { person_email: "dave.alias@liatrio.com", granularity: "person" }),
  rec("2026-10-13", PROV.windsurf, "windsurf", 50),
]

export const emptyOrg = (): OrgData => ({ departments: [], teams: [], people: [], identities: [], apiKeys: [] })

export function attributedRows(org: OrgData = orgData()): AttributedDailyRow[] {
  return toAttributedDailyRows(costRecords, buildOrgIndex(org))
}

/** cost_records_daily: the attributed rows collapsed to (date, provider, model). */
export function plainDailyRows() {
  const m = new Map<string, { date: string; provider_id: string; model_name: string; total_cost_usd: number; total_tokens: number; total_requests: number }>()
  for (const r of attributedRows(emptyOrg())) {
    const k = `${r.date}|${r.provider_id}|${r.model_name}`
    const cur = m.get(k) ?? { date: r.date, provider_id: r.provider_id, model_name: r.model_name, total_cost_usd: 0, total_tokens: 0, total_requests: 0 }
    cur.total_cost_usd += Number(r.total_cost_usd)
    cur.total_tokens += Number(r.total_tokens ?? 0)
    cur.total_requests += Number(r.total_requests ?? 0)
    m.set(k, cur)
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * A chainable, awaitable stand-in for the Supabase query builder. Supports
 * select / order / eq / range; anything awaited resolves to { data, error }.
 * Missing tables resolve to a PostgREST-style "relation does not exist" error.
 */
export function mockSupabase(tables: Record<string, unknown[]>, calls: string[] = []) {
  return {
    from(table: string) {
      calls.push(table)
      let rows = tables[table]
      const error = rows ? null : { code: "42P01", message: `relation "${table}" does not exist` }
      rows = rows ?? []
      let range: [number, number] | null = null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately loose test double
      const builder: any = {
        select: () => builder,
        order: () => builder,
        eq: (col: string, val: unknown) => {
          rows = (rows as Record<string, unknown>[]).filter((r) => r[col] === val)
          return builder
        },
        range: (a: number, b: number) => {
          range = [a, b]
          return builder
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          const data = error ? null : range ? (rows as unknown[]).slice(range[0], range[1] + 1) : rows
          return Promise.resolve({ data, error }).then(resolve, reject)
        },
      }
      return builder
    },
  }
}
