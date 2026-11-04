/**
 * Jest fixture for the Claude.ai product split (issue #48). Records are built
 * by the real collector transforms (lib/collectors/claude-ai.ts), so the
 * metadata.group.product they carry is exactly what production stores.
 *
 * Nov 2026 (Claude.ai, provider CLAUDE_AI):
 *   alice  Nov 1 opus   claude_code 120.00 | Nov 1 sonnet claude_chat 30.00 | Nov 2 opus claude_chat 10.00
 *   bob    Nov 1 opus   claude_code  50.00 | Nov 1 opus   claude_chat 25.00  (same day + model as his Code)
 *   zed    Nov 2 sonnet claude_chat   5.25  (email not in the org: Unassigned)
 *   api    Nov 2 haiku  "api"         3.00  (no person; not Code or Chat: Other)
 *   legacy Nov 2 haiku  (no product)  1.75  (cost_report fallback: unlabelled, Other)
 *   Total 245.00 = Claude Code 170.00 + Chat 70.25 + Other 4.75
 *   Alice 160.00 = 120.00 + 40.00 + 0; Bob 75.00 = 50.00 + 25.00 + 0
 * Oct 2026: alice Oct 5 opus claude_code 40.00 (outside the Nov period).
 */

import { transform, transformAnalytics } from "@/lib/collectors/claude-ai"
import type { CostRecord } from "@/lib/collectors/types"
import type { ProviderRow } from "@/lib/dashboard-compute"
import type { ProductCostRow } from "@/lib/claude-ai-products"
import { buildOrgIndex } from "@/lib/org/attribution"
import { toAttributedDailyRows, type CostRecordLike } from "@/lib/org/rollup"
import { PROVIDERS } from "@/lib/org/dashboard-fixtures"
import { orgData } from "@/lib/org/test-fixtures"
import type { AttributedDailyRow, OrgData } from "@/lib/org/types"

export const CLAUDE_AI = "prov-claude-ai"

export const PROVIDERS_WITH_CLAUDE_AI: ProviderRow[] = [
  ...PROVIDERS,
  { id: CLAUDE_AI, name: "claude-ai", display_name: "Claude.ai (Enterprise Analytics)", metadata: {} },
]

export const NOV_CLAUDE_AI = { total: 245, claude_code: 170, chat: 70.25, other: 4.75 }
export const NOV_ALICE = { total: 160, claude_code: 120, chat: 40, other: 0 }
export const NOV_BOB = { total: 75, claude_code: 50, chat: 25, other: 0 }

const user = (email: string, id: string) => ({ type: "user_actor", user_id: id, email_address: email, name: null, deleted: false })
const ALICE = user("alice@liatrio.com", "u_alice")
const BOB = user("bob@liatrio.com", "u_bob")
const ZED = user("zed@liatrio.com", "u_zed")

const day = (d: string) => ({ starting_at: `${d}T00:00:00Z`, ending_at: `${d}T23:59:59Z` })
const row = (d: string, actor: unknown, model: string, product: string | null, usd: number) => ({
  ...day(d),
  group: { actor, model, product },
  cost: { amount: String(usd * 100), currency: "USD" },
})

const ctx = { userId: "user-1", providerId: CLAUDE_AI }

export function claudeAiRecords(): CostRecord[] {
  const analytics = transformAnalytics(
    [
      row("2026-11-01", ALICE, "claude-opus-4-6", "claude_code", 120),
      row("2026-11-01", ALICE, "claude-sonnet-4-5", "claude_chat", 30),
      row("2026-11-02", ALICE, "claude-opus-4-6", "claude_chat", 10),
      row("2026-11-01", BOB, "claude-opus-4-6", "claude_code", 50),
      row("2026-11-01", BOB, "claude-opus-4-6", "claude_chat", 25),
      row("2026-11-02", ZED, "claude-sonnet-4-5", "claude_chat", 5.25),
      row("2026-11-02", null, "claude-haiku-4-5", "api", 3),
      row("2026-10-05", ALICE, "claude-opus-4-6", "claude_code", 40),
    ],
    [],
    ctx
  )
  // Legacy cost_report fallback: no product on the result.
  const legacy = transform([{ starting_at: "2026-11-02T00:00:00Z", results: [{ model: "claude-haiku-4-5", amount: "175" }] }], [], ctx)
  return [...analytics, ...legacy]
}

/** cost_records rows as the routes select them (product / attribution by JSON path). */
export function claudeAiProductCostRows(records: CostRecord[] = claudeAiRecords()): ProductCostRow[] {
  return records.map((r) => {
    const meta = r.metadata as { group?: { product?: string | null }; attribution?: unknown }
    return {
      provider_id: r.provider_id,
      timestamp: r.timestamp,
      model_name: r.model_name,
      cost_usd: r.cost_usd,
      product: meta.group?.product ?? null,
      attribution: meta.attribution ?? null,
    }
  })
}

const asLike = (records: CostRecord[]): CostRecordLike[] => records as unknown as CostRecordLike[]

/** cost_records_daily_attributed rows for the Claude.ai records. */
export function claudeAiAttributedRows(org: OrgData = orgData()): AttributedDailyRow[] {
  return toAttributedDailyRows(asLike(claudeAiRecords()), buildOrgIndex(org))
}

/** cost_records_daily rows for the Claude.ai records. */
export function claudeAiPlainDailyRows() {
  const byKey = new Map<string, { date: string; provider_id: string; model_name: string; total_cost_usd: number; total_tokens: number; total_requests: number }>()
  for (const r of claudeAiRecords()) {
    const date = r.timestamp.slice(0, 10)
    const k = `${date}|${r.model_name}`
    const g = byKey.get(k) ?? { date, provider_id: r.provider_id, model_name: r.model_name, total_cost_usd: 0, total_tokens: 0, total_requests: 0 }
    g.total_cost_usd += r.cost_usd
    g.total_requests += r.request_count ?? 0
    byKey.set(k, g)
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date))
}
