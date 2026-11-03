/**
 * Jest fixture: the five claude-max seat entries production has (issue #26),
 * one manual_entry per month at 12:00 UTC on the 1st, model 'seats',
 * request_count = seats, $200/seat, $15,600 in total. Same shape as
 * scripts/migration-tests/assertions_016.sql.
 */

import type { SeatEntryRow } from "./seat-assignments"

export const CLAUDE_MAX = "prov-claude-max"
export const OWNER = "u-owner"
export const PROD_SEATS: [string, number][] = [
  ["2026-03", 12],
  ["2026-04", 14],
  ["2026-05", 16],
  ["2026-06", 18],
  ["2026-08", 18],
]
export const PROD_TOTAL = 15600

export function prodSeatRows(): SeatEntryRow[] {
  return PROD_SEATS.map(([month, seats]) => ({
    id: `cm-${month}`,
    user_id: OWNER,
    provider_id: CLAUDE_MAX,
    timestamp: `${month}-01T12:00:00.000Z`,
    model_name: "seats",
    cost_usd: seats * 200,
    request_count: seats,
    collection_method: "manual_entry",
    metadata: {
      entry_type: "monthly_seats",
      month,
      seats,
      price_per_seat: 200,
      cost_basis: "seat_subscription",
      notes: "Ramp cards",
    },
  }))
}
