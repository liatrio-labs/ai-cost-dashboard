/**
 * Pure aggregation of attributed daily rows (cost_records_daily_attributed)
 * by department, team, person or API key. Every level has an explicit
 * Unassigned bucket, so the buckets at any level always sum to the input total.
 *
 * Issue #51: Cursor usage events with no user (Bugbot and other team-level
 * automation) are written with granularity 'org' and no person. When the
 * caller passes the Cursor provider ids (`automationProviderIds`), those rows
 * get their own labelled bucket, "Cursor – Bugbot/automation", just before
 * Unassigned instead of inside it. It is a re-labelling only: the buckets
 * still sum to the input total.
 */

import { CURSOR_SEAT_MODEL, INVOICE_ADJUSTMENT_MODEL, RECURRING_MODEL, RECURRING_SEAT_MODEL } from "@/lib/projection"

/** Bills, not automation: recurring costs (#59), invoice adjustments (#75) and Cursor seat fees (026). */
const BILL_MODELS: ReadonlySet<string> = new Set([RECURRING_MODEL, RECURRING_SEAT_MODEL, INVOICE_ADJUSTMENT_MODEL, CURSOR_SEAT_MODEL])
import { resolveAttribution } from "./attribution"
import type { AttributableRecord, AttributedDailyRow, OrgIndex } from "./types"

export type RollupLevel = "department" | "team" | "person" | "api_key"

export const ROLLUP_LEVELS: readonly RollupLevel[] = ["department", "team", "person", "api_key"]
export const UNASSIGNED_KEY = "unassigned"
export const UNASSIGNED_LABEL = "Unassigned"

/** Bucket key (and filter value) for Cursor spend with no user (issue #51). */
export const AUTOMATION_KEY = "cursor-automation"
export const AUTOMATION_LABEL = "Cursor – Bugbot/automation"
/** Provider slugs whose no-user rows are automation rather than Unassigned. */
export const AUTOMATION_PROVIDER_SLUGS: readonly string[] = ["cursor"]

/** Provider ids (from providers rows) whose no-user spend gets the automation line. */
export function automationProviderIds(providers: readonly { id: string; name: string }[]): Set<string> {
  return new Set(providers.filter((p) => AUTOMATION_PROVIDER_SLUGS.includes(p.name)).map((p) => p.id))
}

/**
 * A Cursor row with no user: org granularity and no person. A Cursor row whose
 * email just isn't a registered person has granularity 'person' and stays
 * Unassigned (someone should add that person). Recurring license / flat-fee
 * rows (issue #59, model "recurring" / "recurring seats") are also org-level
 * with no person, but they are a bill, not automation, so they stay Unassigned.
 * So is an invoice adjustment row (issue #75, model "invoice adjustment").
 */
export function isAutomationRow(
  row: { provider_id: string; person_id?: string | null; granularity?: string | null; model_name?: string | null },
  automationIds: ReadonlySet<string> | null | undefined
): boolean {
  return (
    !!automationIds &&
    automationIds.has(row.provider_id) &&
    !row.person_id &&
    row.granularity === "org" &&
    !(row.model_name && BILL_MODELS.has(row.model_name))
  )
}

export interface RollupTotals {
  total_cost_usd: number
  total_tokens: number
  total_requests: number
  record_count: number
}

export interface RollupBucket extends RollupTotals {
  /** Entity id, or UNASSIGNED_KEY for the Unassigned bucket. */
  key: string
  id: string | null
  label: string
  unassigned: boolean
  /** True for the "Cursor – Bugbot/automation" bucket (issue #51); not Unassigned. */
  automation?: boolean
}

export interface RollupOptions {
  /** Provider ids whose no-user rows go to the automation bucket (see automationProviderIds). */
  automationProviderIds?: ReadonlySet<string> | null
}

export interface OrgRollup {
  total: RollupTotals
  department: RollupBucket[]
  team: RollupBucket[]
  person: RollupBucket[]
  api_key: RollupBucket[]
}

const ID_FIELD: Record<RollupLevel, "department_id" | "team_id" | "person_id" | "org_api_key_id"> = {
  department: "department_id",
  team: "team_id",
  person: "person_id",
  api_key: "org_api_key_id",
}

function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** cost_usd is NUMERIC(12,6); round sums to 6 places to drop float noise. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

function emptyTotals(): RollupTotals {
  return { total_cost_usd: 0, total_tokens: 0, total_requests: 0, record_count: 0 }
}

function addRow(t: RollupTotals, row: AttributedDailyRow): void {
  t.total_cost_usd += num(row.total_cost_usd)
  t.total_tokens += num(row.total_tokens)
  t.total_requests += num(row.total_requests)
  t.record_count += num(row.record_count)
}

function labelFor(level: RollupLevel, id: string, index?: OrgIndex): string {
  if (!index) return id
  switch (level) {
    case "department":
      return index.departmentsById.get(id)?.name ?? id
    case "team":
      return index.teamsById.get(id)?.name ?? id
    case "person": {
      const p = index.peopleById.get(id)
      return p?.display_name || p?.email || id
    }
    case "api_key": {
      const k = index.apiKeysById.get(id)
      return k?.name || k?.external_key_id || id
    }
  }
}

export function totalOf(rows: AttributedDailyRow[]): RollupTotals {
  const t = emptyTotals()
  for (const row of rows) addRow(t, row)
  t.total_cost_usd = round6(t.total_cost_usd)
  return t
}

/** The bucket key a row lands in at `level`: entity id, AUTOMATION_KEY or UNASSIGNED_KEY. */
export function bucketKeyOf(
  row: AttributedDailyRow,
  level: RollupLevel,
  automationIds?: ReadonlySet<string> | null
): string {
  const id = row[ID_FIELD[level]]
  if (id) return id
  return isAutomationRow(row, automationIds) ? AUTOMATION_KEY : UNASSIGNED_KEY
}

/**
 * Aggregate rows at one level. Buckets are sorted by cost (desc, then label);
 * the Unassigned bucket is always present (even at $0) and always last. The
 * automation bucket (issue #51), when it has rows, sits just before it.
 */
export function rollup(
  rows: AttributedDailyRow[],
  level: RollupLevel,
  index?: OrgIndex,
  opts: RollupOptions = {}
): RollupBucket[] {
  const field = ID_FIELD[level]
  const automationIds = opts.automationProviderIds
  let automation: RollupBucket | null = null
  const buckets = new Map<string, RollupBucket>()
  const unassigned: RollupBucket = {
    key: UNASSIGNED_KEY,
    id: null,
    label: UNASSIGNED_LABEL,
    unassigned: true,
    ...emptyTotals(),
  }

  for (const row of rows) {
    const id = row[field]
    let bucket = unassigned
    if (!id && isAutomationRow(row, automationIds)) {
      automation ??= {
        key: AUTOMATION_KEY,
        id: null,
        label: AUTOMATION_LABEL,
        unassigned: false,
        automation: true,
        ...emptyTotals(),
      }
      bucket = automation
    } else if (id) {
      bucket = buckets.get(id) ?? {
        key: id,
        id,
        label: labelFor(level, id, index),
        unassigned: false,
        ...emptyTotals(),
      }
      buckets.set(id, bucket)
    }
    addRow(bucket, row)
  }

  const assigned = [...buckets.values()].sort(
    (a, b) => b.total_cost_usd - a.total_cost_usd || a.label.localeCompare(b.label)
  )
  const tail = automation ? [automation, unassigned] : [unassigned]
  return [...assigned, ...tail].map((b) => ({ ...b, total_cost_usd: round6(b.total_cost_usd) }))
}

export function rollupAll(rows: AttributedDailyRow[], index?: OrgIndex, opts: RollupOptions = {}): OrgRollup {
  return {
    total: totalOf(rows),
    department: rollup(rows, "department", index, opts),
    team: rollup(rows, "team", index, opts),
    person: rollup(rows, "person", index, opts),
    api_key: rollup(rows, "api_key", index, opts),
  }
}

/** A cost_records row as needed to build attributed daily rows in TS. */
export interface CostRecordLike extends AttributableRecord {
  timestamp: string
  model_name: string
  cost_usd: number | string
  tokens_used?: number | string | null
  input_tokens?: number | string | null
  output_tokens?: number | string | null
  request_count?: number | string | null
}

/**
 * TS mirror of cost_records_daily_attributed: resolve each record and group
 * by (UTC date, provider, model, attribution). Useful for previews and tests;
 * production reads the materialized view.
 */
export function toAttributedDailyRows(records: CostRecordLike[], index: OrgIndex): AttributedDailyRow[] {
  const groups = new Map<string, AttributedDailyRow & RollupTotals & {
    total_input_tokens: number
    total_output_tokens: number
  }>()
  for (const r of records) {
    const resolved = resolveAttribution(r, index)
    const date = new Date(r.timestamp).toISOString().slice(0, 10)
    const key = JSON.stringify([
      date,
      r.provider_id,
      r.model_name,
      resolved.person_id,
      resolved.org_api_key_id,
      resolved.team_id,
      resolved.department_id,
      resolved.project_id,
      resolved.workspace_id,
      resolved.granularity,
    ])
    let g = groups.get(key)
    if (!g) {
      g = {
        date,
        provider_id: r.provider_id,
        model_name: r.model_name,
        ...resolved,
        ...emptyTotals(),
        total_input_tokens: 0,
        total_output_tokens: 0,
      }
      groups.set(key, g)
    }
    g.total_cost_usd += num(r.cost_usd)
    g.total_tokens += num(r.tokens_used)
    g.total_input_tokens += num(r.input_tokens)
    g.total_output_tokens += num(r.output_tokens)
    g.total_requests += num(r.request_count)
    g.record_count += 1
  }
  return [...groups.values()].map((g) => ({ ...g, total_cost_usd: round6(g.total_cost_usd) }))
}
