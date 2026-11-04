/**
 * Actual totals the dashboard and breakdown report for a set of fixtures,
 * filters and periods (issue #39). projection-totals.test.ts compares them
 * with projection-totals-baseline.json, captured from main before projections
 * were added, so projections can't change an actual total.
 */

import { computeDashboard } from "@/lib/dashboard-compute"
import { applyFilters, type DashboardFilters } from "@/lib/dashboard-filters"
import { FORECAST_DEFAULTS } from "@/lib/forecast-settings"
import { computeBreakdown } from "@/lib/org/breakdown"
import { PROVIDERS, attributedRows } from "@/lib/org/dashboard-fixtures"
import { D, PE, T, orgData } from "@/lib/org/test-fixtures"
import { DD, NOW_39, PP, PROVIDERS_39, TT, KK, org39, rows39 } from "@/lib/projection-fixtures"
import type { PeriodParams } from "@/lib/dashboard-compute"

export const SNAPSHOT_CASES = {
  base: {
    now: new Date("2026-11-15T00:00:00Z"),
    providers: PROVIDERS,
    rows: () => attributedRows(),
    org: () => orgData(),
    filters: [{}, { person: PE.alice }, { team: T.data }, { department: D.eng }, { provider: "openai" }] as DashboardFilters[],
  },
  issue39: {
    now: NOW_39,
    providers: PROVIDERS_39,
    rows: () => rows39(),
    org: () => org39(),
    filters: [{}, { person: PP.heavy }, { person: PP.seat }, { person: PP.fresh }, { team: TT.core }, { department: DD.eng }, { key: KK.heavy }, { provider: "openai" }] as DashboardFilters[],
  },
}

export const SNAPSHOT_PERIODS: PeriodParams[] = [
  { month: "2026-11" },
  { month: "2026-10" },
  { start: "2026-10-20", end: "2026-11-10" },
  { start: "2026-12-01", end: "2026-12-31" },
]

const ent = (es: { key: string; cost: number; prevCost: number; changePercent: number | null }[]) =>
  es.map((e) => [e.key, e.cost, e.prevCost, e.changePercent])

export function totalsSnapshot() {
  const out: Record<string, unknown> = {}
  for (const [name, c] of Object.entries(SNAPSHOT_CASES)) {
    for (const params of SNAPSHOT_PERIODS) {
      for (const filters of c.filters) {
        const id = `${name} ${JSON.stringify(params)} ${JSON.stringify(filters)}`
        const rows = c.rows()
        const providerId = filters.provider ? (c.providers.find((p) => p.name === filters.provider)?.id ?? null) : null
        const d = computeDashboard({
          daily: applyFilters(rows, filters, providerId),
          providers: c.providers,
          params,
          forecastSettings: FORECAST_DEFAULTS,
          now: c.now,
          projectForecast: Object.keys(filters).length === 0,
        })
        const b = computeBreakdown({ rows, org: c.org(), providers: c.providers, filters, params, now: c.now })
        out[id] = {
          kpis: { totalSpend: d.kpis.totalSpend, prevSpend: d.kpis.prevSpend, changePercent: d.kpis.changePercent, totalTokens: d.kpis.totalTokens },
          tools: d.tools.map((t) => [t.id, t.monthlySpend, t.changePercent, t.changeDirection]),
          trends: d.trends,
          months: d.months,
          byModel: d.byModel,
          breakdown: {
            total: b.total,
            department: ent(b.department),
            team: ent(b.team),
            person: ent(b.person),
            api_key: ent(b.api_key),
            project: ent(b.project),
          },
        }
      }
    }
  }
  return out
}
