/**
 * Jest fixture shaped like issue #39 (prod on Nov 4, 2026): a full September
 * and October, then Nov 1 (a Sunday) to Nov 3 complete and Nov 4 partial.
 * OpenAI was last collected Nov 3 15:56 UTC, so for it Nov 3 is partial and it
 * is complete through Nov 2. ChatGPT Business is a manual $900 row on the 1st
 * (billed Oct 1, not yet in November). Claude Ultra (`claude-max`) seats are
 * monthly rows on the 1st with model 'seats'.
 *
 * Weekday usage is a fixed amount per person and provider; weekends run at
 * 20% of a weekday, like prod (Oct 24-25: $1.8k/$1.3k vs $6-10k weekdays).
 *
 * People:
 *   p-heavy  anthropic + cursor + openai key, steady usage
 *   p-seat   only a Claude Ultra seat ($200 on the 1st), no usage
 *   p-new    first spend on Nov 2 (no previous full month)
 *   p-mixed  claude-ai usage plus a Claude Ultra seat
 */

import type { ProviderRow } from "@/lib/dashboard-compute"
import type { AttributedDailyRow, OrgData } from "@/lib/org/types"

export const NOW_39 = new Date("2026-11-04T10:00:00Z")

export const PV = {
  anthropic: "pv-anthropic",
  cursor: "pv-cursor",
  claudeAi: "pv-claude-ai",
  openai: "pv-openai",
  chatgpt: "pv-chatgpt",
  claudeMax: "pv-claude-max",
}

export const PROVIDERS_39: ProviderRow[] = [
  { id: PV.anthropic, name: "anthropic", display_name: "Anthropic (Claude API)", last_collected_at: "2026-11-04T08:55:00Z", metadata: {} },
  { id: PV.chatgpt, name: "chatgpt", display_name: "ChatGPT Business", last_collected_at: null, metadata: { collection_method: "manual" } },
  { id: PV.claudeAi, name: "claude-ai", display_name: "Claude.ai", last_collected_at: "2026-11-04T09:10:00Z", metadata: {} },
  { id: PV.claudeMax, name: "claude-max", display_name: "Claude Ultra", last_collected_at: null, metadata: { collection_method: "manual" } },
  { id: PV.cursor, name: "cursor", display_name: "Cursor (Admin API)", last_collected_at: "2026-11-04T09:00:00Z", metadata: {} },
  { id: PV.openai, name: "openai", display_name: "OpenAI API", last_collected_at: "2026-11-03T15:56:00Z", metadata: {} },
]

export const PP = { heavy: "p-heavy", seat: "p-seat", fresh: "p-new", mixed: "p-mixed" }
export const TT = { core: "t-core", field: "t-field" }
export const DD = { eng: "d-eng" }
export const KK = { heavy: "k-heavy" }

export function org39(): OrgData {
  return {
    departments: [{ id: DD.eng, name: "Engineering" }],
    teams: [
      { id: TT.core, name: "Core", department_id: DD.eng },
      { id: TT.field, name: "Field", department_id: null },
    ],
    people: [
      { id: PP.heavy, email: "heavy@liatrio.com", display_name: "Heavy", team_id: TT.core },
      { id: PP.seat, email: "seat@liatrio.com", display_name: "Seat", team_id: TT.field },
      { id: PP.fresh, email: "new@liatrio.com", display_name: "New", team_id: TT.core },
      { id: PP.mixed, email: "mixed@liatrio.com", display_name: "Mixed", team_id: TT.field },
    ],
    identities: [],
    apiKeys: [
      { id: KK.heavy, provider_id: PV.openai, external_key_id: "key_heavy", name: "Heavy key", owner_person_id: PP.heavy, team_id: null },
    ],
    projects: [],
  }
}

const TEAM: Record<string, string | null> = { [PP.heavy]: TT.core, [PP.seat]: TT.field, [PP.fresh]: TT.core, [PP.mixed]: TT.field }
const DEPT: Record<string, string | null> = { [TT.core]: DD.eng, [TT.field]: null }

function row(date: string, provider_id: string, model_name: string, cost: number, person: string | null, key: string | null = null): AttributedDailyRow {
  const team_id = person ? TEAM[person] : null
  return {
    date,
    provider_id,
    model_name,
    total_cost_usd: Math.round(cost * 100) / 100,
    total_tokens: 1000,
    total_requests: 1,
    record_count: 1,
    person_id: person,
    org_api_key_id: key,
    team_id,
    department_id: team_id ? DEPT[team_id] : null,
    project_id: null,
    workspace_id: null,
    granularity: key ? "api_key" : person ? "person" : "org",
  }
}

const isWeekend = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return d === 0 || d === 6
}

function days(start: string, end: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/** Weekday spend per day; weekends are 20% of it. */
const USAGE: [string, string, string, number, string | null][] = [
  // [person, provider, model, weekday $, key]
  [PP.heavy, PV.anthropic, "claude-opus", 500, null],
  [PP.heavy, PV.cursor, "cursor-auto", 100, null],
  [PP.heavy, PV.openai, "gpt-5", 50, KK.heavy],
  [PP.mixed, PV.claudeAi, "claude-ai", 40, null],
]

/** Usage per day; partial days log a fraction of a normal day. */
function usageRows(dates: string[], fraction: (date: string, provider: string) => number = () => 1): AttributedDailyRow[] {
  const out: AttributedDailyRow[] = []
  for (const date of dates) {
    for (const [person, provider, model, weekday, key] of USAGE) {
      const f = fraction(date, provider)
      if (f <= 0) continue
      out.push(row(date, provider, model, weekday * (isWeekend(date) ? 0.2 : 1) * f, person, key))
    }
  }
  return out
}

/** Rows as cost_records_daily_attributed would hold them on Nov 4, 2026. */
export function rows39(): AttributedDailyRow[] {
  const out: AttributedDailyRow[] = []
  for (const month of ["2026-09", "2026-10"]) {
    out.push(row(`${month}-01`, PV.chatgpt, "chatgpt-business", 900, null))
    out.push(row(`${month}-01`, PV.claudeMax, "seats", 200, PP.seat))
    out.push(row(`${month}-01`, PV.claudeMax, "seats", 200, PP.mixed))
  }
  out.push(...usageRows([...days("2026-09-01", "2026-09-30"), ...days("2026-10-01", "2026-10-31")]))
  // November: seats billed on the 1st (ChatGPT not yet), Nov 1-3 complete,
  // Nov 4 partial for everyone, Nov 3 partial for OpenAI.
  out.push(row("2026-11-01", PV.claudeMax, "seats", 200, PP.seat))
  out.push(row("2026-11-01", PV.claudeMax, "seats", 200, PP.mixed))
  out.push(
    ...usageRows(days("2026-11-01", "2026-11-04"), (date, provider) => {
      if (date === "2026-11-04") return provider === PV.openai ? 0 : 0.25
      if (date === "2026-11-03" && provider === PV.openai) return 0.5
      return 1
    })
  )
  // A new person: first spend on Monday Nov 2.
  out.push(row("2026-11-02", PV.anthropic, "claude-sonnet", 80, PP.fresh))
  out.push(row("2026-11-03", PV.anthropic, "claude-sonnet", 80, PP.fresh))
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** The same rows without attribution columns, as cost_records_daily holds them. */
export function plainRows39() {
  const byKey = new Map<string, { date: string; provider_id: string; model_name: string; total_cost_usd: number; total_tokens: number; total_requests: number }>()
  for (const r of rows39()) {
    const k = `${r.date}|${r.provider_id}|${r.model_name}`
    const cur = byKey.get(k) ?? { date: r.date, provider_id: r.provider_id, model_name: r.model_name, total_cost_usd: 0, total_tokens: 0, total_requests: 0 }
    cur.total_cost_usd = Math.round((cur.total_cost_usd + Number(r.total_cost_usd)) * 1e6) / 1e6
    cur.total_tokens += Number(r.total_tokens)
    cur.total_requests += Number(r.total_requests)
    byKey.set(k, cur)
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date))
}
