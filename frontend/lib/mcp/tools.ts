/**
 * Issue #94: the MCP server's tools. All read-only: each one calls the same
 * loaders the dashboard routes use (lib/dashboard-service.ts) with the
 * caller's own RLS-scoped Supabase client, and reshapes the payload for an
 * agent. There is no collect, backfill, seat-assign, rate, invoice-override,
 * admin or secret tool, and no tool writes anything.
 *
 * Spend rules carried over from the dashboard, unchanged:
 *  - Fixed / subscription = seats, licenses, flat bills; Variable / usage =
 *    metered on-demand only. Cursor included-in-business usage comes with
 *    seats and is stored at $0, so it never shows as extra cost.
 *  - Cursor product buckets come from cursorProductBucket (Grok Bot =
 *    grok-bot-*, Bugbot = github_bugbot, Seats = seat fees, Agent/Chat =
 *    everything else).
 *  - Cursor billing-cycle on-demand (/teams/spend snapshots) is a separate
 *    measure, never added to calendar-month usage or to seat fees.
 */

import { loadBreakdown, loadCursorCycle, loadDashboard } from "@/lib/dashboard-service"
import { fetchCursorSeatData, fetchOrgData, fetchProviders, type SupabaseLike } from "@/lib/dashboard-data"
import { CURSOR_SLUG, seatCycle, seatTypeFor, rateFor, type AssignableSeatType } from "@/lib/cursor-seats"
import { groupSeatEntries, isSeatProvider, MANUAL_METHODS, SEAT_ENTRY_TYPE, type SeatEntryRow } from "@/lib/org/seat-assignments"
import { userFacingProviderName } from "@/lib/cost-types"
import type { OrgData } from "@/lib/org/types"
import type { BreakdownApiKey, BreakdownEntity } from "@/lib/org/breakdown"

export interface ToolContext {
  supabase: SupabaseLike
  caller: { email: string; userId: string }
  now?: Date
}

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false }
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>
}

export class ToolInputError extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

const round2 = (n: unknown) => {
  const v = typeof n === "number" ? n : Number(n)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0
}

const SPEND_RULES = {
  fixed: "Fixed / subscription: seats, licenses and flat monthly bills.",
  variable: "Variable / usage: metered on-demand spend only. Cursor included-in-business usage comes with seats and is $0, never extra cost.",
  cursorCycle: "Cursor billing-cycle on-demand is a separate measure (get_cursor_billing_cycle) and is not included in these calendar-month totals.",
}

// ---- input schema pieces -------------------------------------------------

const PERIOD_PROPS = {
  month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description: "Calendar month YYYY-MM. Defaults to the current month." },
  start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Custom range start YYYY-MM-DD (use with end instead of month)." },
  end: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Custom range end YYYY-MM-DD, inclusive." },
}

const FILTER_PROPS = {
  department: { type: "string", description: "Department id or name (\"unassigned\" for spend with no department)." },
  team: { type: "string", description: "Team id or name (\"unassigned\" for spend with no team)." },
  person: { type: "string", description: "Person id, @liatrio.com email, or display name." },
  key: { type: "string", description: "API key id (from get_api_key_spend)." },
  provider: { type: "string", description: "Provider slug, e.g. cursor, anthropic, openai, claude-ai, claude-max." },
}

function schema(props: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties: props, required, additionalProperties: false }
}

// ---- argument handling ---------------------------------------------------

function str(args: Record<string, unknown>, k: string): string | undefined {
  const v = args[k]
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v !== "string") throw new ToolInputError(`${k} must be a string`)
  const t = v.trim()
  if (t.length > 200) throw new ToolInputError(`${k} is too long`)
  return t || undefined
}

function periodParams(args: Record<string, unknown>): Record<string, string> {
  const month = str(args, "month")
  const start = str(args, "start")
  const end = str(args, "end")
  if (month && (start || end)) throw new ToolInputError("Pass either month or start/end, not both")
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ToolInputError("month must be YYYY-MM")
    return { month }
  }
  if (start || end) {
    const iso = /^\d{4}-\d{2}-\d{2}$/
    if (!start || !end || !iso.test(start) || !iso.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
      throw new ToolInputError("start and end must both be YYYY-MM-DD")
    }
    if (start > end) throw new ToolInputError("start must be on or before end")
    return { start, end }
  }
  return {}
}

const norm = (s: string) => s.trim().toLowerCase()

/** Resolve a department / team / person given by id, name or (people) email to its id. */
export function resolveOrgFilter(kind: "department" | "team" | "person", value: string, org: OrgData): string {
  if (norm(value) === "unassigned") return "unassigned"
  const v = norm(value)
  const pool =
    kind === "department"
      ? org.departments.map((d) => ({ id: d.id, names: [d.name] }))
      : kind === "team"
        ? org.teams.map((t) => ({ id: t.id, names: [t.name] }))
        : org.people.map((p) => ({ id: p.id, names: [p.email, p.display_name ?? ""] }))
  const byId = pool.find((e) => e.id === value)
  if (byId) return byId.id
  const matches = pool.filter((e) => e.names.some((n) => n && norm(n) === v))
  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) throw new ToolInputError(`${kind} "${value}" is ambiguous; use its id (see list_org_directory)`)
  throw new ToolInputError(`No ${kind} matches "${value}" (see list_org_directory)`)
}

async function queryParams(
  args: Record<string, unknown>,
  ctx: ToolContext,
  opts: { period?: boolean; personDefault?: "caller" } = {}
): Promise<{ sp: URLSearchParams; org: OrgData | null; personId: string | null }> {
  const sp = new URLSearchParams(opts.period === false ? {} : periodParams(args))
  const raw = {
    department: str(args, "department"),
    team: str(args, "team"),
    person: str(args, "person") ?? (opts.personDefault === "caller" ? ctx.caller.email : undefined),
    key: str(args, "key"),
    provider: str(args, "provider"),
  }
  let org: OrgData | null = null
  if (raw.department || raw.team || raw.person) org = await fetchOrgData(ctx.supabase)
  let personId: string | null = null
  for (const kind of ["department", "team", "person"] as const) {
    const v = raw[kind]
    if (!v) continue
    const id = resolveOrgFilter(kind, v, org!)
    if (kind === "person") personId = id
    sp.set(kind, id)
  }
  if (raw.key) sp.set("key", raw.key)
  if (raw.provider) sp.set("provider", norm(raw.provider))
  return { sp, org, personId }
}

// ---- output shaping ------------------------------------------------------

function entity(e: BreakdownEntity) {
  return {
    id: e.id,
    key: e.key,
    name: e.label,
    unassigned: e.unassigned,
    ...(e.automation ? { automation: true } : {}),
    spend: round2(e.cost),
    previousSpend: round2(e.prevCost),
    changePercent: e.changePercent,
    projectedSpend: e.projectedCost === null ? null : round2(e.projectedCost),
    byProvider: Object.fromEntries(Object.entries(e.byProvider).map(([k, v]) => [k, round2(v)])),
    ...(e.coverage.length ? { coverageNotes: e.coverage.map((c) => `${c.providerName}: ${c.note}`) } : {}),
  }
}

function apiKey(k: BreakdownApiKey) {
  return { ...entity(k), provider: k.provider, providerName: k.providerName, owner: k.owner, team: k.team }
}

function limited<T>(list: T[], args: Record<string, unknown>): { items: T[]; truncated: boolean } {
  const raw = args.limit
  const n = raw === undefined ? 100 : Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ToolInputError("limit must be an integer from 1 to 1000")
  return { items: list.slice(0, n), truncated: list.length > n }
}

const LIMIT_PROP = { limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum rows (default 100)." } }

async function breakdownFor(args: Record<string, unknown>, ctx: ToolContext, personDefault?: "caller") {
  const { sp, personId } = await queryParams(args, ctx, { personDefault })
  const b = await loadBreakdown(ctx.supabase, sp, ctx.now)
  return { b, personId }
}

function periodOut(p: { start: string; end: string; mode: string; selectedMonth?: string | null }) {
  return { start: p.start, end: p.end, mode: p.mode, month: p.selectedMonth ?? null }
}

// ---- tools ---------------------------------------------------------------

const getMonthlyHeadline: McpTool = {
  name: "get_monthly_headline",
  title: "Monthly headline",
  description:
    "Total AI spend for a month (or range) with Fixed / subscription vs Variable / usage, the change vs the previous period and the projection, optionally narrowed to a department, team, person, API key or provider. Same numbers as the dashboard headline.",
  inputSchema: schema({ ...PERIOD_PROPS, ...FILTER_PROPS }),
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const { sp } = await queryParams(args, ctx)
    const d = await loadDashboard(ctx.supabase, sp, ctx.now)
    const total = round2(d.kpis.totalSpend)
    const fixed = round2(d.kpis.fixedSpend ?? 0)
    return {
      period: { ...d.period, month: d.selectedMonth },
      filters: d.filters,
      totalSpend: total,
      fixedSubscriptionSpend: fixed,
      variableUsageSpend: round2(d.kpis.variableSpend ?? total - fixed),
      previousPeriodSpend: round2(d.kpis.prevSpend),
      changePercent: d.kpis.changePercent,
      topProvider: d.kpis.topProvider,
      activeProviders: d.kpis.activeProviders,
      projection: d.projection ?? null,
      availableMonths: d.months,
      notes: [SPEND_RULES.fixed, SPEND_RULES.variable, SPEND_RULES.cursorCycle],
    }
  },
}

const getSpendByTool: McpTool = {
  name: "get_spend_by_tool",
  title: "Spend by provider / tool",
  description:
    "Spend per provider/tool for a month (or range), with product splits: Cursor (Grok Bot, Bugbot, Agent/Chat, Seats) with seats vs calendar-month on-demand, and Claude.ai (Claude Code, Chat, Other). Also lists seat and license totals. Optional org/provider filters.",
  inputSchema: schema({ ...PERIOD_PROPS, ...FILTER_PROPS }),
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const { sp } = await queryParams(args, ctx)
    const d = await loadDashboard(ctx.supabase, sp, ctx.now)
    return {
      period: { ...d.period, month: d.selectedMonth },
      filters: d.filters,
      totalSpend: round2(d.kpis.totalSpend),
      tools: d.tools.map((t) => ({
        id: t.id,
        name: t.name,
        spend: round2(t.monthlySpend),
        changePercent: t.changePercent,
        subscriptionType: t.subscriptionType,
        ...(t.projectedSpend !== undefined ? { projectedSpend: round2(t.projectedSpend) } : {}),
        ...(t.products ? { products: t.products.map((p) => ({ product: p.product, label: p.label, spend: round2(p.cost) })) } : {}),
        ...(t.cursorCostTypes
          ? {
              cursorCostTypes: {
                seatsSubscription: round2(t.cursorCostTypes.seats),
                calendarMonthOnDemand: round2(t.cursorCostTypes.calendarOnDemand),
                seatComposition: t.cursorCostTypes.seatComposition,
              },
            }
          : {}),
        lastUpdated: t.lastUpdated ?? null,
      })),
      licenses: (d.byLicense ?? []).map((l) => ({ label: l.label, kind: l.kind, provider: l.provider, spend: round2(l.total) })),
      notes: [
        "Cursor products: Grok Bot = grok-bot-* models; Bugbot = github_bugbot; Seats = seat subscription fees; Agent/Chat = everything else (including grok-4.7-* and cursor-grok-* models).",
        SPEND_RULES.variable,
        SPEND_RULES.cursorCycle,
      ],
    }
  },
}

const getSpendByPerson: McpTool = {
  name: "get_spend_by_person",
  title: "Spend by person",
  description:
    "Spend per person for a month (or range), largest first, with Unassigned and Cursor automation rows, optionally within a department, team or provider. Same rows as the dashboard People table.",
  inputSchema: schema({ ...PERIOD_PROPS, department: FILTER_PROPS.department, team: FILTER_PROPS.team, provider: FILTER_PROPS.provider, ...LIMIT_PROP }),
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const { b } = await breakdownFor(args, ctx)
    const { items, truncated } = limited(b.person, args)
    return { period: periodOut(b.period), filters: b.filters, total: round2(b.total.cost), people: items.map(entity), truncated }
  },
}

const getPersonSpend: McpTool = {
  name: "get_person_spend",
  title: "One person's spend",
  description:
    "One person's spend for a month (or range): total, Fixed vs Variable, per-provider and per-model detail, and Cursor / Claude.ai product splits. Defaults to the signed-in caller.",
  inputSchema: schema({ ...PERIOD_PROPS, person: FILTER_PROPS.person, provider: FILTER_PROPS.provider }),
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const { sp, org, personId } = await queryParams(args, ctx, { personDefault: "caller" })
    const [b, d] = await Promise.all([loadBreakdown(ctx.supabase, sp, ctx.now), loadDashboard(ctx.supabase, sp, ctx.now)])
    const person = org?.people.find((p) => p.id === personId) ?? null
    // Headline figures (total, Fixed / Variable, change, by provider) all come from the
    // dashboard KPIs so they always reconcile: fixed + variable === total. The breakdown
    // supplies only the per-model detail and product splits.
    const total = round2(d.kpis.totalSpend)
    const fixed = round2(d.kpis.fixedSpend ?? 0)
    return {
      period: periodOut(b.period),
      person: person ? { id: person.id, name: person.display_name || person.email } : { id: personId },
      totalSpend: total,
      previousPeriodSpend: round2(d.kpis.prevSpend),
      changePercent: d.kpis.changePercent,
      fixedSubscriptionSpend: fixed,
      variableUsageSpend: round2(d.kpis.variableSpend ?? total - fixed),
      byProvider: d.tools.map((t) => ({ id: t.id, name: t.name, spend: round2(t.monthlySpend) })),
      detail: b.detail.map((r) => ({ provider: r.provider, providerName: r.providerName, model: r.model, spend: round2(r.cost), tokens: r.tokens, requests: r.requests })),
      cursorProducts: b.cursorProducts?.products.map((p) => ({ product: p.product, label: p.label, spend: round2(p.cost) })) ?? null,
      claudeAiProducts: b.claudeAiProducts?.products.map((p) => ({ product: p.product, label: p.label, spend: round2(p.cost) })) ?? null,
      notes: [SPEND_RULES.variable, SPEND_RULES.cursorCycle],
    }
  },
}

const getSpendByDepartment: McpTool = {
  name: "get_spend_by_department",
  title: "Spend by department",
  description: "Spend per department for a month (or range), with Unassigned, optionally for one provider. Same rows as the dashboard Departments table.",
  inputSchema: schema({ ...PERIOD_PROPS, provider: FILTER_PROPS.provider }),
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const { b } = await breakdownFor(args, ctx)
    return { period: periodOut(b.period), filters: b.filters, total: round2(b.total.cost), departments: b.department.map(entity) }
  },
}

const getSpendByTeam: McpTool = {
  name: "get_spend_by_team",
  title: "Spend by team",
  description: "Spend per team for a month (or range), with Unassigned, optionally within one department or for one provider. Same rows as the dashboard Teams table.",
  inputSchema: schema({ ...PERIOD_PROPS, department: FILTER_PROPS.department, provider: FILTER_PROPS.provider }),
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const { b } = await breakdownFor(args, ctx)
    return { period: periodOut(b.period), filters: b.filters, total: round2(b.total.cost), teams: b.team.map(entity) }
  },
}

const getApiKeySpend: McpTool = {
  name: "get_api_key_spend",
  title: "API key spend",
  description:
    "Spend per provider API key (name, owner, team; never the secret) for a month (or range). Keys with $0 in the period are hidden unless include_zero is true, as in the dashboard.",
  inputSchema: schema({
    ...PERIOD_PROPS,
    ...FILTER_PROPS,
    include_zero: { type: "boolean", description: "Include keys with no spend in the period (default false)." },
    ...LIMIT_PROP,
  }),
  annotations: READ_ONLY,
  async handler(args, ctx) {
    if (args.include_zero !== undefined && typeof args.include_zero !== "boolean") throw new ToolInputError("include_zero must be a boolean")
    const { b } = await breakdownFor(args, ctx)
    const keys = args.include_zero ? b.api_key : b.api_key.filter((k) => Math.abs(k.cost) >= 0.005)
    const { items, truncated } = limited(keys, args)
    return { period: periodOut(b.period), filters: b.filters, total: round2(b.total.cost), apiKeys: items.map(apiKey), truncated }
  },
}

const getCursorBillingCycle: McpTool = {
  name: "get_cursor_billing_cycle",
  title: "Cursor billing-cycle on-demand",
  description:
    "Cursor on-demand spend for the current billing cycle (from Cursor /teams/spend snapshots) and earlier cycles' totals, optionally scoped to a department, team or person. A separate measure: do not add it to calendar-month usage or seat fees.",
  inputSchema: schema({ department: FILTER_PROPS.department, team: FILTER_PROPS.team, person: FILTER_PROPS.person }),
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const { sp } = await queryParams(args, ctx, { period: false })
    const v = await loadCursorCycle(ctx.supabase, sp)
    if (!v.available) return { available: false, notice: v.notice }
    const c = v.current
    return {
      available: true,
      scope: v.scope,
      current: c
        ? {
            cycleStart: c.cycleStart,
            cycleEnd: c.cycleEnd,
            cycleEndEstimated: c.cycleEndEstimated,
            capturedAt: c.capturedAt,
            teamOnDemandSpend: round2(c.teamSpendCents / 100),
            selectionOnDemandSpend: c.selectionSpendCents === null ? null : round2(c.selectionSpendCents / 100),
            memberCount: c.memberCount,
            members: c.members.map((m) => ({
              email: m.email,
              name: m.name,
              onDemandSpend: m.spendCents === null ? null : round2(m.spendCents / 100),
              monthlyLimitDollars: m.monthlyLimitDollars,
              effectivePerUserLimitDollars: m.effectivePerUserLimitDollars,
            })),
          }
        : null,
      previousCycles: v.previous.map((p) => ({ cycleStart: p.cycleStart, cycleEnd: p.cycleEnd, teamOnDemandSpend: round2(p.teamSpendCents / 100), capturedAt: p.capturedAt })),
      notes: [
        "Billing-cycle on-demand only. Included usage is not cost. This is not part of calendar-month totals or seat fees; never add them together.",
      ],
    }
  },
}

/** cost_records seat entries (Claude Ultra, ChatGPT, ...), read as the caller. */
interface SeatQuery extends PromiseLike<{ data: unknown[] | null; error: unknown }> {
  in(column: string, values: unknown[]): SeatQuery
  eq(column: string, value: unknown): SeatQuery
  order(column: string): SeatQuery
  range(from: number, to: number): SeatQuery
}

async function fetchSeatEntries(supabase: SupabaseLike, providerIds: string[]): Promise<SeatEntryRow[]> {
  if (!providerIds.length) return []
  const out: SeatEntryRow[] = []
  for (let from = 0; ; from += 1000) {
    const q = supabase
      .from("cost_records")
      .select("id, user_id, provider_id, timestamp, model_name, cost_usd, request_count, collection_method, metadata") as unknown as SeatQuery
    const { data, error } = await q
      .in("provider_id", providerIds)
      .in("collection_method", [...MANUAL_METHODS])
      .eq("metadata->>entry_type", SEAT_ENTRY_TYPE)
      .order("id")
      .range(from, from + 999)
    if (error) throw error
    const rows = (data || []) as SeatEntryRow[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

const getSeatAssignments: McpTool = {
  name: "get_seat_assignments",
  title: "Seat assignments (read-only)",
  description:
    "Who holds which seat for a month: Cursor seat type (standard / premium / free) and rate for the 20th-to-20th seat cycle, and per-person seats of seat-based tools such as Claude Ultra and ChatGPT. Read-only context for attribution; editing stays in the admin UI.",
  inputSchema: schema({ month: PERIOD_PROPS.month, person: FILTER_PROPS.person }),
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const { month } = periodParams({ month: args.month })
    const ym = month ?? (ctx.now ?? new Date()).toISOString().slice(0, 7)
    const [providers, org, cursor] = await Promise.all([fetchProviders(ctx.supabase), fetchOrgData(ctx.supabase), fetchCursorSeatData(ctx.supabase)])
    const personArg = str(args, "person")
    const personId = personArg ? resolveOrgFilter("person", personArg, org) : null
    const people = personId ? org.people.filter((p) => p.id === personId) : org.people
    const teamName = new Map(org.teams.map((t) => [t.id, t.name]))
    const cycle = seatCycle(ym)

    const cursorSeats = cursor.available
      ? people
          .map((p) => ({ p, type: seatTypeFor(cursor.assignments, p.id, ym) as AssignableSeatType }))
          .filter(({ type }) => type !== "none")
          .map(({ p, type }) => ({
            personId: p.id,
            name: p.display_name || p.email,
            team: p.team_id ? teamName.get(p.team_id) ?? null : null,
            seatType: type,
            cycleRate: rateFor(cursor.rates, type, ym),
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : []

    const seatProviders = providers.filter((p) => p.name !== CURSOR_SLUG && isSeatProvider(p))
    const groups = groupSeatEntries(await fetchSeatEntries(ctx.supabase, seatProviders.map((p) => p.id))).filter((g) => g.month === ym)
    const emails = personId ? new Set(people.map((p) => p.email.toLowerCase())) : null
    const byEmail = new Map(org.people.map((p) => [p.email.toLowerCase(), p]))
    const otherSeats = groups.map((g) => {
      const provider = providers.find((p) => p.id === g.provider_id)
      const assigned = g.assignments
        .filter((a) => !emails || emails.has(a.person_email))
        .map((a) => {
          const p = byEmail.get(a.person_email)
          return { personId: p?.id ?? null, name: p ? p.display_name || p.email : a.person_email, seats: a.seats, spend: round2(a.cost_usd) }
        })
      return {
        provider: provider?.name ?? g.provider_id,
        providerName: provider ? userFacingProviderName(provider.name, provider.display_name) : g.provider_id,
        month: g.month,
        // The whole provider-month bill, labeled as such so a person-scoped call can't be
        // read as that person's cost; their share is personSeats / personSpend.
        orgTotalSeats: g.total_seats,
        orgTotalSpend: round2(g.total_usd),
        pricePerSeat: round2(g.price_per_seat),
        assignments: assigned,
        ...(personId
          ? { personSeats: assigned.reduce((n, a) => n + a.seats, 0), personSpend: round2(assigned.reduce((n, a) => n + a.spend, 0)) }
          : { unassignedSeats: g.remainder.seats }),
      }
    })

    return {
      month: ym,
      cursor: {
        available: cursor.available,
        seatCycle: { start: cycle.start, endExclusive: cycle.end, label: cycle.label },
        seats: cursorSeats,
      },
      otherSeatTools: otherSeats,
      notes: ["Read-only. Cursor seat fees are fixed subscription cost; included usage that comes with a seat is not extra cost."],
    }
  },
}

const listOrgDirectory: McpTool = {
  name: "list_org_directory",
  title: "Org directory",
  description: "Departments, teams and people (ids and names) to use as filters in the other tools, plus which person is the signed-in caller.",
  inputSchema: schema({}),
  annotations: READ_ONLY,
  async handler(_args, ctx) {
    const org = await fetchOrgData(ctx.supabase)
    const me = org.people.find((p) => p.email.toLowerCase() === ctx.caller.email) ?? null
    return {
      caller: { email: ctx.caller.email, personId: me?.id ?? null },
      departments: org.departments.map((d) => ({ id: d.id, name: d.name })),
      teams: org.teams.map((t) => ({ id: t.id, name: t.name, departmentId: t.department_id })),
      people: org.people
        .filter((p) => p.active !== false)
        .map((p) => ({ id: p.id, name: p.display_name || p.email, teamId: p.team_id })),
    }
  },
}

export const MCP_TOOLS: readonly McpTool[] = [
  getMonthlyHeadline,
  getSpendByTool,
  getSpendByPerson,
  getPersonSpend,
  getSpendByDepartment,
  getSpendByTeam,
  getApiKeySpend,
  getCursorBillingCycle,
  getSeatAssignments,
  listOrgDirectory,
]
