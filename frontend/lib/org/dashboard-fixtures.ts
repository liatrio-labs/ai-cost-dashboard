/**
 * Jest fixture for the dashboard breakdown (issue #8): the org from
 * test-fixtures.ts plus two months of cost records across providers.
 *
 * Nov 2026 (current): anthropic alice 100, anthropic bob (identity) 50,
 *   openai key_team 40 (team Data, owner Alice), openai key_bare 10,
 *   cursor dave (identity) 30, windsurf org 20. Total 250.
 * Oct 2026 (previous): anthropic alice 50, cursor dave 30, windsurf 20,
 *   anthropic carol (no team) 5. Total 105.
 */

import type { ProviderRow } from "@/lib/dashboard-compute"
import { buildOrgIndex } from "./attribution"
import { toAttributedDailyRows, type CostRecordLike } from "./rollup"
import { P, orgData } from "./test-fixtures"
import type { AttributedDailyRow, OrgData } from "./types"

export const WINDSURF = "prov-windsurf"

export const PROVIDERS: ProviderRow[] = [
  { id: P.anthropic, name: "anthropic", display_name: "Anthropic (Claude API)", metadata: {} },
  { id: P.cursor, name: "cursor", display_name: "Cursor (Admin API)", metadata: {} },
  { id: P.openai, name: "openai", display_name: "OpenAI API", metadata: {} },
  { id: WINDSURF, name: "windsurf", display_name: "Windsurf (CascadeAnalytics)", metadata: {} },
]

const rec = (provider_id: string, timestamp: string, model_name: string, cost_usd: number, attribution?: Record<string, unknown>): CostRecordLike => ({
  provider_id,
  timestamp,
  model_name,
  cost_usd,
  tokens_used: 1000,
  input_tokens: 600,
  output_tokens: 400,
  request_count: 10,
  metadata: attribution ? { attribution } : {},
})

export const RECORDS: CostRecordLike[] = [
  // November 2026
  rec(P.anthropic, "2026-11-01T10:00:00Z", "claude-opus", 60, { person_email: "alice@liatrio.com", granularity: "person" }),
  rec(P.anthropic, "2026-11-02T10:00:00Z", "claude-sonnet", 40, { person_email: "alice@liatrio.com", granularity: "person" }),
  rec(P.anthropic, "2026-11-01T11:00:00Z", "claude-opus", 50, { person_external_id: "user_bob", granularity: "person" }),
  rec(P.openai, "2026-11-01T12:00:00Z", "gpt-5", 40, { api_key_id: "key_team", granularity: "api_key" }),
  rec(P.openai, "2026-11-01T13:00:00Z", "gpt-5", 10, { api_key_id: "key_bare", granularity: "api_key" }),
  rec(P.cursor, "2026-11-01T14:00:00Z", "cursor-auto", 30, { person_email: "dave.alias@liatrio.com", granularity: "person" }),
  rec(WINDSURF, "2026-11-01T00:00:00Z", "windsurf-seats", 20),
  // October 2026
  rec(P.anthropic, "2026-10-05T10:00:00Z", "claude-opus", 50, { person_email: "alice@liatrio.com", granularity: "person" }),
  rec(P.cursor, "2026-10-05T14:00:00Z", "cursor-auto", 30, { person_email: "dave.alias@liatrio.com", granularity: "person" }),
  rec(WINDSURF, "2026-10-01T00:00:00Z", "windsurf-seats", 20),
  rec(P.anthropic, "2026-10-06T10:00:00Z", "claude-haiku", 5, { person_email: "carol@liatrio.com", granularity: "person" }),
]

export const NOV_TOTAL = 250
export const OCT_TOTAL = 105

export const EMPTY_ORG: OrgData = { departments: [], teams: [], people: [], identities: [], apiKeys: [] }

/** Rows as cost_records_daily_attributed would hold them for `org`. */
export function attributedRows(org: OrgData = orgData()): AttributedDailyRow[] {
  return toAttributedDailyRows(RECORDS, buildOrgIndex(org))
}

/** Rows as cost_records_daily would hold them (no attribution columns). */
export function plainDailyRows() {
  const byKey = new Map<string, { date: string; provider_id: string; model_name: string; total_cost_usd: number; total_tokens: number; total_requests: number }>()
  for (const r of RECORDS) {
    const date = r.timestamp.slice(0, 10)
    const k = `${date}|${r.provider_id}|${r.model_name}`
    const row = byKey.get(k) ?? { date, provider_id: r.provider_id, model_name: r.model_name, total_cost_usd: 0, total_tokens: 0, total_requests: 0 }
    row.total_cost_usd += Number(r.cost_usd)
    row.total_tokens += Number(r.tokens_used)
    row.total_requests += Number(r.request_count)
    byKey.set(k, row)
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date))
}
