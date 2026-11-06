/** Jest fixtures for issue #88 (Nov 2026: Claude Ultra seats, Cursor seats + on-demand, Anthropic usage). */

import type { DailyRow, ProviderRow } from "@/lib/dashboard-compute"
import type { SeatRate } from "@/lib/cursor-seats"

export const PROV: ProviderRow[] = [
  { id: "pv-anthropic", name: "anthropic", display_name: "Anthropic (Claude API)", metadata: {} },
  {
    id: "pv-claude-max",
    name: "claude-max",
    display_name: "Claude Max",
    metadata: { collection_method: "manual", description: "Claude Max seats on personal cards" },
  },
  { id: "pv-cursor", name: "cursor", display_name: "Cursor (Admin API)", metadata: {} },
]

export const RATES: SeatRate[] = [
  { seat_type: "standard", effective_month: "2026-10-01", monthly_rate_usd: 40 },
  { seat_type: "premium", effective_month: "2026-10-01", monthly_rate_usd: "60" },
  { seat_type: "free", effective_month: "2026-10-01", monthly_rate_usd: 0 },
]

export const row = (date: string, provider_id: string, model_name: string, cost: number): DailyRow => ({
  date,
  provider_id,
  model_name,
  total_cost_usd: cost,
  total_tokens: 0,
})

export function novRows(): DailyRow[] {
  return [
    row("2026-11-01", "pv-claude-max", "seats", 7600),
    ...[40, 40, 40, 60, 60].map((c) => row("2026-11-01", "pv-cursor", "cursor seats", c)),
    row("2026-11-03", "pv-cursor", "grok-bot-default", 100),
    row("2026-11-03", "pv-anthropic", "claude-opus-5-5", 500),
    row("2026-10-03", "pv-anthropic", "claude-opus-5-5", 400),
  ]
}
