/**
 * Cursor billing-cycle on-demand spend from the documented Admin API
 * (issue #76). No dashboard scraping.
 *
 * POST https://api.cursor.com/teams/spend (Basic auth, admin key as username)
 *   Body:     { page, pageSize }
 *   Response: {
 *     teamMemberSpend: [{
 *       userId, email, name, role,
 *       spendCents,                    // ON-DEMAND this cycle (excludes included usage)
 *       overallSpendCents,             // included + on-demand; never billed as such
 *       fastPremiumRequests,
 *       monthlyLimitDollars,           // team per-user default limit (null = none)
 *       hardLimitOverrideDollars,      // per-member override (null/0 = none)
 *       effectivePerUserLimitDollars,  // the limit that applies to the member
 *     }],
 *     subscriptionCycleStart,          // epoch ms, current cycle only
 *     totalMembers, totalPages,
 *   }
 *
 * The endpoint only reports the CURRENT billing cycle, so snapshotCursorSpend()
 * stores it (migration 025) hourly and after each Cursor collection. When the
 * cycle resets, the previous cycle keeps its last snapshot and the database
 * refuses any later change to it.
 *
 * Billing-cycle figures are kept apart from everything else: nothing here
 * touches cost_records, so usage events stay the source for daily history,
 * calendar-month totals and the by-product split (Bugbot / Grok / kind).
 *
 * The team's cycle on-demand total is the sum of members' spendCents.
 * overallSpendCents is stored and shown for context but is never substituted
 * for spendCents.
 */

import { fetchWithRetry, sleep } from "@/lib/collectors/http"

export const CURSOR_API_BASE_URL = "https://api.cursor.com"
const SPEND_PAGE_SIZE = 100
const MAX_SPEND_PAGES = 100 // safety backstop against pagination loops

export const CURSOR_CYCLES_TABLE = "cursor_spend_cycles"
export const CURSOR_MEMBER_CYCLE_TABLE = "cursor_member_cycle_spend"
export const CURSOR_SNAPSHOT_RPC = "record_cursor_spend_snapshot"

export const MIGRATION_025_MESSAGE =
  "Cursor billing-cycle spend needs database migration 025 (database/migrations/025_cursor_cycle_spend.sql), which isn't applied yet. Existing totals are unaffected."

/** One teamMemberSpend row as documented. Every field is optional on the wire. */
export interface CursorTeamMemberSpend {
  userId?: number | string | null
  email?: string | null
  name?: string | null
  role?: string | null
  spendCents?: number | string | null
  overallSpendCents?: number | string | null
  fastPremiumRequests?: number | null
  monthlyLimitDollars?: number | string | null
  hardLimitOverrideDollars?: number | string | null
  effectivePerUserLimitDollars?: number | string | null
}

export interface CursorSpendPage {
  teamMemberSpend?: CursorTeamMemberSpend[] | null
  subscriptionCycleStart?: number | string | null
  totalMembers?: number | null
  totalPages?: number | null
}

/** A member's row in a snapshot (the shape the RPC and the tables take). */
export interface CursorMemberSnapshot {
  email: string
  name: string | null
  cursor_user_id: string | null
  role: string | null
  /** spendCents: on-demand this cycle. null when the API omitted it. */
  spend_cents: number | null
  /** overallSpendCents: included + on-demand. Informational only. */
  overall_spend_cents: number | null
  monthly_limit_dollars: number | null
  hard_limit_override_dollars: number | null
  effective_per_user_limit_dollars: number | null
}

export interface CursorSpendSnapshot {
  /** subscriptionCycleStart as ISO 8601 UTC. */
  cycleStart: string
  capturedAt: string
  members: CursorMemberSnapshot[]
  /** Sum of members' spendCents: the team's on-demand total for the cycle. */
  teamSpendCents: number
  /** Sum of members' overallSpendCents (null when none reported it). Never billed on-demand. */
  teamOverallSpendCents: number | null
}

/** Finite number from a number or numeric string, else null. Never invents a value. */
export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

const strOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s ? s : null
}

/** subscriptionCycleStart (epoch ms number/string, or ISO string) -> ISO, else null. */
export function cycleStartIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  const asNum = typeof value === "number" ? value : Number(value)
  const ms = Number.isFinite(asNum) ? asNum : Date.parse(String(value))
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms).toISOString()
}

/** Sum cents without float drift (to 1/10000 of a cent). */
const sumCents = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 1e4) / 1e4

/**
 * Build a snapshot from one or more /teams/spend pages. Pure.
 *
 * - Members are keyed by lower-cased email; rows without an email are
 *   dropped; a duplicate email keeps its first row.
 * - spend_cents is spendCents only. A missing spendCents stays null (counts
 *   as 0 in the team total) and is never filled from overallSpendCents.
 * - Returns null when no page carries a subscriptionCycleStart (the snapshot
 *   can't be keyed to a cycle) or the pages disagree on it.
 */
export function buildCursorSpendSnapshot(pages: CursorSpendPage[], capturedAt: Date): CursorSpendSnapshot | null {
  const starts = new Set<string>()
  for (const p of pages) {
    const s = cycleStartIso(p?.subscriptionCycleStart)
    if (s) starts.add(s)
  }
  if (starts.size !== 1) return null
  const [cycleStart] = [...starts]

  const byEmail = new Map<string, CursorMemberSnapshot>()
  for (const p of pages) {
    for (const row of p?.teamMemberSpend ?? []) {
      const email = strOrNull(row?.email)?.toLowerCase()
      if (!email || byEmail.has(email)) continue
      byEmail.set(email, {
        email,
        name: strOrNull(row?.name),
        cursor_user_id: strOrNull(row?.userId),
        role: strOrNull(row?.role),
        spend_cents: numOrNull(row?.spendCents),
        overall_spend_cents: numOrNull(row?.overallSpendCents),
        monthly_limit_dollars: numOrNull(row?.monthlyLimitDollars),
        hard_limit_override_dollars: numOrNull(row?.hardLimitOverrideDollars),
        effective_per_user_limit_dollars: numOrNull(row?.effectivePerUserLimitDollars),
      })
    }
  }
  const members = [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email))
  const overall = members.map((m) => m.overall_spend_cents).filter((v): v is number => v !== null)
  return {
    cycleStart,
    capturedAt: capturedAt.toISOString(),
    members,
    teamSpendCents: sumCents(members.map((m) => m.spend_cents ?? 0)),
    teamOverallSpendCents: overall.length ? sumCents(overall) : null,
  }
}

function basicAuthHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64")
}

/** Fetch every /teams/spend page. Throws on a non-OK response. */
export async function fetchCursorTeamSpend(apiKey: string): Promise<CursorSpendPage[]> {
  const pages: CursorSpendPage[] = []
  for (let page = 1; page <= MAX_SPEND_PAGES; page++) {
    const res = await fetchWithRetry(`${CURSOR_API_BASE_URL}/teams/spend`, {
      method: "POST",
      headers: { Authorization: basicAuthHeader(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ page, pageSize: SPEND_PAGE_SIZE }),
    })
    if (!res.ok) throw new Error(`Cursor /teams/spend request failed: ${res.status}`)
    const json = (await res.json()) as CursorSpendPage
    pages.push(json)
    const totalPages = numOrNull(json?.totalPages) ?? 1
    const batch = json?.teamMemberSpend ?? []
    if (page >= totalPages || batch.length === 0) break
    await sleep(250)
  }
  return pages
}

/** PostgREST / Postgres errors meaning migration 025 isn't applied. */
export function isMissingCursorSpendSchema(error: unknown): boolean {
  const e = (error ?? {}) as { code?: string; message?: string }
  return (
    e.code === "42P01" || // undefined_table
    e.code === "PGRST205" || // table not in schema cache
    e.code === "PGRST202" || // function not in schema cache
    e.code === "42883" || // undefined_function
    /(relation|table|function) .*(cursor_spend_cycles|cursor_member_cycle_spend|record_cursor_spend_snapshot)/i.test(
      e.message ?? ""
    )
  )
}

export type SnapshotStatus = "inserted" | "updated" | "stale" | "migration_missing" | "no_cycle" | "error"

export interface SnapshotResult {
  status: SnapshotStatus
  cycle_start?: string
  members?: number
  team_spend_cents?: number
  reason?: string
}

/** Minimal client shape for the snapshot write (an admin SupabaseClient fits). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

/**
 * Store a snapshot through record_cursor_spend_snapshot (migration 025).
 * Never throws: a missing migration reads as `migration_missing` and writes
 * nothing.
 */
export async function persistCursorSpendSnapshot(
  client: RpcClient,
  snapshot: CursorSpendSnapshot,
  teamId?: string | null
): Promise<SnapshotResult> {
  try {
    const { data, error } = await client.rpc(CURSOR_SNAPSHOT_RPC, {
      p_cycle_start: snapshot.cycleStart,
      p_captured_at: snapshot.capturedAt,
      p_team_id: teamId ?? null,
      p_members: snapshot.members,
    })
    if (error) {
      if (isMissingCursorSpendSchema(error)) {
        return { status: "migration_missing", cycle_start: snapshot.cycleStart, reason: MIGRATION_025_MESSAGE }
      }
      const message = (error as { message?: string }).message ?? String(error)
      return { status: "error", cycle_start: snapshot.cycleStart, reason: message }
    }
    const status: SnapshotStatus = data === "stale" ? "stale" : data === "updated" ? "updated" : "inserted"
    return {
      status,
      cycle_start: snapshot.cycleStart,
      members: snapshot.members.length,
      team_spend_cents: snapshot.teamSpendCents,
      ...(status === "stale" ? { reason: "snapshot is older than the latest stored cycle; nothing written" } : {}),
    }
  } catch (e) {
    return { status: "error", cycle_start: snapshot.cycleStart, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Fetch /teams/spend and store the current cycle's snapshot. Never throws.
 * `now` is injectable for tests.
 */
export async function snapshotCursorSpend(
  client: RpcClient,
  opts: { apiKey: string; teamId?: string | null; now?: Date; fetchPages?: (apiKey: string) => Promise<CursorSpendPage[]> }
): Promise<SnapshotResult> {
  let pages: CursorSpendPage[]
  try {
    pages = await (opts.fetchPages ?? fetchCursorTeamSpend)(opts.apiKey)
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message : String(e) }
  }
  const snapshot = buildCursorSpendSnapshot(pages, opts.now ?? new Date())
  if (!snapshot) return { status: "no_cycle", reason: "/teams/spend returned no single subscriptionCycleStart" }
  return persistCursorSpendSnapshot(client, snapshot, opts.teamId)
}

// ----------------------------------------------------------------------------
// Read side (dashboard)
// ----------------------------------------------------------------------------

/** A cycle's reset date: one calendar month after its start (UTC), day clamped to the month. */
export function nextCycleStart(cycleStart: string): string {
  const d = new Date(cycleStart)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
  ).toISOString()
}

export interface CycleRow {
  cycle_start: string
  team_spend_cents: number | string | null
  team_overall_spend_cents: number | string | null
  member_count: number | null
  first_captured_at: string | null
  captured_at: string | null
}

export interface MemberCycleRow extends Omit<CursorMemberSnapshot, "email"> {
  cycle_start: string
  member_email: string
  captured_at: string | null
}

export interface CursorCycleSummary {
  cycleStart: string
  /** Reset date (exclusive end). Exact for a past cycle, estimated (start + 1 month) for the current one. */
  cycleEnd: string
  cycleEndEstimated: boolean
  /** Sum of members' spendCents. */
  teamSpendCents: number
  /** Sum of members' overallSpendCents (included + on-demand). Informational. */
  teamOverallSpendCents: number | null
  memberCount: number
  /** Latest snapshot of the cycle. For a past cycle: its final snapshot. */
  capturedAt: string | null
  firstCapturedAt: string | null
}

export interface CursorCycleMember {
  email: string
  name: string | null
  role: string | null
  spendCents: number | null
  overallSpendCents: number | null
  monthlyLimitDollars: number | null
  hardLimitOverrideDollars: number | null
  effectivePerUserLimitDollars: number | null
}

export type CursorCycleView =
  | { available: false; notice: string }
  | {
      available: true
      current: (CursorCycleSummary & { members: CursorCycleMember[] }) | null
      previous: CursorCycleSummary[]
    }

/** Build the dashboard view from stored rows. Pure. */
export function buildCursorCycleView(cycles: CycleRow[], members: MemberCycleRow[]): CursorCycleView {
  const sorted = [...cycles].sort((a, b) => Date.parse(b.cycle_start) - Date.parse(a.cycle_start))
  const summaries: CursorCycleSummary[] = sorted.map((c, i) => {
    const later = i > 0 ? sorted[i - 1] : null
    return {
      cycleStart: new Date(c.cycle_start).toISOString(),
      cycleEnd: later ? new Date(later.cycle_start).toISOString() : nextCycleStart(c.cycle_start),
      cycleEndEstimated: !later,
      teamSpendCents: numOrNull(c.team_spend_cents) ?? 0,
      teamOverallSpendCents: numOrNull(c.team_overall_spend_cents),
      memberCount: c.member_count ?? 0,
      capturedAt: c.captured_at,
      firstCapturedAt: c.first_captured_at,
    }
  })
  if (!summaries.length) return { available: true, current: null, previous: [] }
  const [current, ...previous] = summaries
  const currentMs = Date.parse(current.cycleStart)
  const currentMembers: CursorCycleMember[] = members
    .filter((m) => Date.parse(m.cycle_start) === currentMs)
    .map((m) => ({
      email: m.member_email,
      name: m.name ?? null,
      role: m.role ?? null,
      spendCents: numOrNull(m.spend_cents),
      overallSpendCents: numOrNull(m.overall_spend_cents),
      monthlyLimitDollars: numOrNull(m.monthly_limit_dollars),
      hardLimitOverrideDollars: numOrNull(m.hard_limit_override_dollars),
      effectivePerUserLimitDollars: numOrNull(m.effective_per_user_limit_dollars),
    }))
    .sort((a, b) => (b.spendCents ?? 0) - (a.spendCents ?? 0) || a.email.localeCompare(b.email))
  return { available: true, current: { ...current, members: currentMembers }, previous }
}

export const CYCLE_COLUMNS = "cycle_start, team_spend_cents, team_overall_spend_cents, member_count, first_captured_at, captured_at"
export const MEMBER_CYCLE_COLUMNS =
  "cycle_start, member_email, member_name, cursor_user_id, role, spend_cents, overall_spend_cents, monthly_limit_dollars, hard_limit_override_dollars, effective_per_user_limit_dollars, captured_at"

interface ReadQuery extends PromiseLike<{ data: unknown[] | null; error: unknown }> {
  order(column: string, options?: { ascending?: boolean }): ReadQuery
  eq(column: string, value: unknown): ReadQuery
}
export interface ReadClient {
  from(table: string): { select(columns: string): ReadQuery }
}

/** How many past cycles the dashboard lists. */
export const PREVIOUS_CYCLES_SHOWN = 12

/**
 * Read stored cycles for the dashboard. A missing migration 025 reads as
 * `{ available: false, notice }`; other errors throw.
 */
export async function readCursorCycleSpend(client: ReadClient): Promise<CursorCycleView> {
  const cyclesRes = await client.from(CURSOR_CYCLES_TABLE).select(CYCLE_COLUMNS).order("cycle_start", { ascending: false })
  if (cyclesRes.error) {
    if (isMissingCursorSpendSchema(cyclesRes.error)) return { available: false, notice: MIGRATION_025_MESSAGE }
    throw cyclesRes.error
  }
  const cycles = ((cyclesRes.data ?? []) as CycleRow[]).slice(0, PREVIOUS_CYCLES_SHOWN + 1)
  if (!cycles.length) return { available: true, current: null, previous: [] }
  const latest = cycles.reduce((a, b) => (Date.parse(b.cycle_start) > Date.parse(a.cycle_start) ? b : a))
  const membersRes = await client
    .from(CURSOR_MEMBER_CYCLE_TABLE)
    .select(MEMBER_CYCLE_COLUMNS)
    .eq("cycle_start", latest.cycle_start)
    .order("member_email", { ascending: true })
  if (membersRes.error) {
    if (isMissingCursorSpendSchema(membersRes.error)) return { available: false, notice: MIGRATION_025_MESSAGE }
    throw membersRes.error
  }
  const members = ((membersRes.data ?? []) as Array<MemberCycleRow & { member_name?: string | null }>).map((m) => ({
    ...m,
    name: m.member_name ?? m.name ?? null,
  }))
  return buildCursorCycleView(cycles, members)
}
