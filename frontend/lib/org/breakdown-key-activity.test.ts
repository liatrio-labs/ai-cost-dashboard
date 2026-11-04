/**
 * Issue #45: every key in key_groups carries its provider status, its spend
 * in the last 90 days (independent of the selected period), its last spend
 * date and, when migration 018 is applied, the provider's creation date.
 */

import { computeBreakdown, type BreakdownData, type BreakdownKeyItem } from "./breakdown"
import { OK, PROVIDERS_WITH_GATEWAY, ownedKeysOrg, ownedKeysRows } from "./dashboard-fixtures"
import { considerRevoking } from "./key-filter"
import type { OrgData } from "./types"

const NOW = new Date("2026-11-15T00:00:00Z") // window starts 2026-08-17

function org(): OrgData {
  const o = ownedKeysOrg()
  const status: Record<string, string> = {
    [OK.anZero]: "active",
    [OK.anOld]: "active",
    [OK.anBobZero]: "archived",
    [OK.anDataTeam]: "inactive",
  }
  return {
    ...o,
    apiKeys: o.apiKeys.map((k) => ({
      ...k,
      external_status: status[k.id] ?? null,
      provider_created_at: k.id === OK.anOld ? "2025-01-02T03:04:05Z" : null,
    })),
  }
}

const run = (month: string) =>
  computeBreakdown({ rows: ownedKeysRows(), org: org(), providers: PROVIDERS_WITH_GATEWAY, filters: {}, params: { month }, now: NOW })
const items = (d: BreakdownData): BreakdownKeyItem[] => d.key_groups.flatMap((pg) => pg.projects.flatMap((g) => g.keys))
const byId = (d: BreakdownData, id: string) => items(d).find((k) => k.id === id)!

describe("key activity on the API keys table (issue #45)", () => {
  const d = run("2026-11")

  it("carries status, 90-day spend, last spend date and provider_created_at", () => {
    expect(byId(d, OK.anOld)).toMatchObject({ status: "active", spend_90d: 0, last_spend: "2026-08-10", provider_created_at: "2025-01-02T03:04:05Z" })
    expect(byId(d, OK.gwBob)).toMatchObject({ status: null, spend_90d: 25, last_spend: "2026-11-03", provider_created_at: null })
    expect(byId(d, OK.anZero)).toMatchObject({ status: "active", spend_90d: 0, last_spend: null })
    expect(byId(d, OK.anBobZero).status).toBe("archived")
  })

  it("90-day spend doesn't depend on the selected period", () => {
    const aug = run("2026-08")
    expect(byId(aug, OK.anOld).cost).toBe(12)
    expect(byId(aug, OK.anOld).spend_90d).toBe(0)
    expect(byId(aug, OK.gwBob).spend_90d).toBe(25)
  })

  it("consider revoking lists the active keys with $0 in 90 days, never-spent first", () => {
    expect(considerRevoking(items(d), (k) => ({ status: k.status, spend90d: k.spend_90d, lastSpend: k.last_spend, label: k.label })).map((k) => k.id)).toEqual([
      OK.anZero,
      OK.anOld,
    ])
  })
})
