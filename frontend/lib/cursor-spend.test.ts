/**
 * @jest-environment node
 *
 * Issue #76: Cursor /teams/spend billing-cycle snapshots. Fixtures and fakes
 * only: no network, no database. The database-level guarantees (prior cycles
 * immutable, stale snapshots refused) are also asserted against real Postgres
 * in scripts/migration-tests/assertions_025.sql.
 */

import {
  MIGRATION_025_MESSAGE,
  buildCursorCycleView,
  buildCursorSpendSnapshot,
  cycleStartIso,
  fetchCursorTeamSpend,
  isMissingCursorSpendSchema,
  nextCycleStart,
  persistCursorSpendSnapshot,
  readCursorCycleSpend,
  snapshotCursorSpend,
  type CursorMemberSnapshot,
  type CursorSpendPage,
  type CycleRow,
  type MemberCycleRow,
  type ReadClient,
  type RpcClient,
} from "./cursor-spend"
import { transform } from "./collectors/cursor"
import { POST_COLLECT_SYNC } from "./collectors/runner"
import { splitCursorByProduct } from "./cursor-products"
import type { SupabaseClient } from "@supabase/supabase-js"

const OCT19 = Date.UTC(2026, 9, 19, 0, 0, 0)
const NOV19 = Date.UTC(2026, 10, 19, 0, 0, 0)
const OCT19_ISO = new Date(OCT19).toISOString()
const NOV19_ISO = new Date(NOV19).toISOString()

/** A /teams/spend page as documented (fixture values, not real spend). */
function spendPage(cycleStart: number, overrides: Record<string, Record<string, unknown>> = {}): CursorSpendPage {
  const rows = [
    {
      userId: 101,
      email: "Alice@Example.com",
      name: "Alice",
      role: "member",
      spendCents: 2450,
      overallSpendCents: 9450, // includes 7000 of included usage
      fastPremiumRequests: 12,
      monthlyLimitDollars: 100,
      hardLimitOverrideDollars: null,
      effectivePerUserLimitDollars: 100,
    },
    {
      userId: 102,
      email: "bob@example.com",
      name: "Bob",
      role: "owner",
      spendCents: 0, // all usage inside the included pool
      overallSpendCents: 4000,
      monthlyLimitDollars: 100,
      hardLimitOverrideDollars: 250,
      effectivePerUserLimitDollars: 250,
    },
    {
      userId: 103,
      email: "carol@example.com",
      name: "Carol",
      role: "member",
      spendCents: 1234.5, // invoice-level precision
      overallSpendCents: 1234.5,
      monthlyLimitDollars: null,
      hardLimitOverrideDollars: null,
      effectivePerUserLimitDollars: null,
    },
  ].map((r) => ({ ...r, ...(overrides[r.email.toLowerCase()] ?? {}) }))
  return { teamMemberSpend: rows, subscriptionCycleStart: cycleStart, totalMembers: rows.length, totalPages: 1 }
}

const at = (iso: string) => new Date(iso)

describe("member and team spendCents totals", () => {
  test("each member's on-demand is spendCents; the team total is the sum of spendCents", () => {
    const snap = buildCursorSpendSnapshot([spendPage(OCT19)], at("2026-10-25T12:00:00Z"))!
    expect(snap.cycleStart).toBe(OCT19_ISO)
    expect(Object.fromEntries(snap.members.map((m) => [m.email, m.spend_cents]))).toEqual({
      "alice@example.com": 2450,
      "bob@example.com": 0,
      "carol@example.com": 1234.5,
    })
    expect(snap.teamSpendCents).toBe(2450 + 0 + 1234.5)
    // overallSpendCents (included + on-demand) is kept apart.
    expect(snap.teamOverallSpendCents).toBe(9450 + 4000 + 1234.5)
    expect(snap.teamSpendCents).not.toBe(snap.teamOverallSpendCents)
  })

  test("a missing spendCents is never filled from overallSpendCents", () => {
    const page = spendPage(OCT19, { "alice@example.com": { spendCents: undefined } })
    const snap = buildCursorSpendSnapshot([page], at("2026-10-25T12:00:00Z"))!
    const alice = snap.members.find((m) => m.email === "alice@example.com")!
    expect(alice.spend_cents).toBeNull()
    expect(alice.overall_spend_cents).toBe(9450)
    expect(snap.teamSpendCents).toBe(1234.5)
  })

  test("pages are combined, emails lower-cased and de-duplicated, rows without email dropped", () => {
    const p1 = spendPage(OCT19)
    const p2: CursorSpendPage = {
      subscriptionCycleStart: String(OCT19),
      teamMemberSpend: [
        { email: "dave@example.com", spendCents: 500 },
        { email: "ALICE@example.com", spendCents: 99999 }, // duplicate: first row wins
        { email: null, spendCents: 777 },
      ],
    }
    const snap = buildCursorSpendSnapshot([p1, p2], at("2026-10-25T12:00:00Z"))!
    expect(snap.members.map((m) => m.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
      "dave@example.com",
    ])
    expect(snap.teamSpendCents).toBe(2450 + 1234.5 + 500)
  })

  test("no snapshot without a single subscriptionCycleStart", () => {
    expect(buildCursorSpendSnapshot([{ teamMemberSpend: [] }], new Date())).toBeNull()
    expect(buildCursorSpendSnapshot([spendPage(OCT19), spendPage(NOV19)], new Date())).toBeNull()
    expect(cycleStartIso("not a date")).toBeNull()
    expect(cycleStartIso(String(OCT19))).toBe(OCT19_ISO)
  })

  test("fetchCursorTeamSpend follows totalPages with the documented request (mocked fetch)", async () => {
    const bodies: unknown[] = []
    const original = global.fetch
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.cursor.com/teams/spend")
      expect(init?.method).toBe("POST")
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      const page: CursorSpendPage =
        body.page === 1
          ? { ...spendPage(OCT19), totalPages: 2 }
          : { subscriptionCycleStart: OCT19, totalPages: 2, teamMemberSpend: [{ email: "dave@example.com", spendCents: 1 }] }
      return new Response(JSON.stringify(page), { status: 200 })
    }) as typeof fetch
    try {
      const pages = await fetchCursorTeamSpend("test-key")
      expect(pages).toHaveLength(2)
      expect(bodies).toEqual([
        { page: 1, pageSize: 100 },
        { page: 2, pageSize: 100 },
      ])
    } finally {
      global.fetch = original
    }
  })
})

/** Records rpc calls; answers like record_cursor_spend_snapshot would. */
function fakeRpc(answer: (args: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const client: RpcClient = {
    rpc: (fn, args) => {
      calls.push({ fn, args })
      return Promise.resolve(answer(args))
    },
  }
  return { client, calls }
}

describe("persisted limit, overall and cycle fields", () => {
  test("the snapshot sends every documented field to record_cursor_spend_snapshot", async () => {
    const { client, calls } = fakeRpc(() => ({ data: "inserted", error: null }))
    const result = await snapshotCursorSpend(client, {
      apiKey: "test-key",
      teamId: "team-42",
      now: at("2026-10-25T12:00:00Z"),
      fetchPages: async () => [spendPage(OCT19)],
    })
    expect(result).toMatchObject({ status: "inserted", cycle_start: OCT19_ISO, members: 3, team_spend_cents: 3684.5 })
    expect(calls).toHaveLength(1)
    expect(calls[0].fn).toBe("record_cursor_spend_snapshot")
    expect(calls[0].args).toMatchObject({
      p_cycle_start: OCT19_ISO,
      p_captured_at: "2026-10-25T12:00:00.000Z",
      p_team_id: "team-42",
    })
    const members = calls[0].args.p_members as CursorMemberSnapshot[]
    expect(members.find((m) => m.email === "bob@example.com")).toEqual({
      email: "bob@example.com",
      name: "Bob",
      cursor_user_id: "102",
      role: "owner",
      spend_cents: 0,
      overall_spend_cents: 4000,
      monthly_limit_dollars: 100,
      hard_limit_override_dollars: 250,
      effective_per_user_limit_dollars: 250,
    })
    expect(members.find((m) => m.email === "carol@example.com")).toMatchObject({
      monthly_limit_dollars: null,
      hard_limit_override_dollars: null,
      effective_per_user_limit_dollars: null,
    })
  })

  test("the view exposes cycle dates, per-member limits and both totals", () => {
    const cycles: CycleRow[] = [
      {
        cycle_start: OCT19_ISO,
        team_spend_cents: "3684.5000",
        team_overall_spend_cents: "14684.5000",
        member_count: 3,
        first_captured_at: "2026-10-19T01:05:00Z",
        captured_at: "2026-10-25T12:00:00Z",
      },
    ]
    const members: MemberCycleRow[] = [
      {
        cycle_start: OCT19_ISO,
        member_email: "bob@example.com",
        name: "Bob",
        cursor_user_id: "102",
        role: "owner",
        spend_cents: 0,
        overall_spend_cents: 4000,
        monthly_limit_dollars: 100,
        hard_limit_override_dollars: 250,
        effective_per_user_limit_dollars: 250,
        captured_at: "2026-10-25T12:00:00Z",
      },
    ]
    const view = buildCursorCycleView(cycles, members)
    if (!view.available) throw new Error("expected available")
    expect(view.current).toMatchObject({
      cycleStart: OCT19_ISO,
      cycleEnd: NOV19_ISO,
      cycleEndEstimated: true,
      teamSpendCents: 3684.5,
      teamOverallSpendCents: 14684.5,
      memberCount: 3,
    })
    expect(view.current!.members[0]).toEqual({
      email: "bob@example.com",
      name: "Bob",
      role: "owner",
      spendCents: 0,
      overallSpendCents: 4000,
      monthlyLimitDollars: 100,
      hardLimitOverrideDollars: 250,
      effectivePerUserLimitDollars: 250,
    })
  })

  test("the estimated reset is one calendar month later, day clamped", () => {
    expect(nextCycleStart(OCT19_ISO)).toBe(NOV19_ISO)
    expect(nextCycleStart("2026-01-31T00:00:00.000Z")).toBe("2026-02-28T00:00:00.000Z")
    expect(nextCycleStart("2026-12-19T00:00:00.000Z")).toBe("2027-01-19T00:00:00.000Z")
  })
})

/**
 * In-memory stand-in for migration 025's write path, following the same rules
 * as record_cursor_spend_snapshot: older-than-latest is 'stale' (nothing
 * written), the latest cycle is upserted, earlier cycles are never touched.
 */
function memoryStore() {
  const cycles = new Map<string, CycleRow>()
  const members = new Map<string, MemberCycleRow>()
  const client: RpcClient = {
    rpc: (_fn, args) => {
      const start = String(args.p_cycle_start)
      const capturedAt = String(args.p_captured_at)
      const latest = [...cycles.keys()].sort().at(-1)
      if (latest && start < latest) return Promise.resolve({ data: "stale", error: null })
      const status = latest === start ? "updated" : "inserted"
      for (const m of args.p_members as CursorMemberSnapshot[]) {
        const { email, ...rest } = m
        members.set(`${start}|${email}`, { ...rest, cycle_start: start, member_email: email, captured_at: capturedAt })
      }
      const rows = [...members.values()].filter((m) => m.cycle_start === start)
      const prev = cycles.get(start)
      cycles.set(start, {
        cycle_start: start,
        team_spend_cents: rows.reduce((s, r) => s + (r.spend_cents ?? 0), 0),
        team_overall_spend_cents: rows.reduce((s, r) => s + (r.overall_spend_cents ?? 0), 0),
        member_count: rows.length,
        first_captured_at: prev?.first_captured_at ?? capturedAt,
        captured_at: capturedAt,
      })
      return Promise.resolve({ data: status, error: null })
    },
  }
  return { client, cycles, members, view: () => buildCursorCycleView([...cycles.values()], [...members.values()]) }
}

describe("cycle snapshot preservation and rollover", () => {
  test("Oct 19 cycle keeps its final snapshot after the Nov 19 reset; a stale Oct snapshot is refused", async () => {
    const store = memoryStore()
    const snap = (cycle: number, iso: string, overrides = {}) =>
      snapshotCursorSpend(store.client, { apiKey: "k", now: at(iso), fetchPages: async () => [spendPage(cycle, overrides)] })

    expect((await snap(OCT19, "2026-10-19T01:05:00Z", { "alice@example.com": { spendCents: 100 } })).status).toBe("inserted")
    // Later snapshot of the same cycle replaces the running figures.
    expect((await snap(OCT19, "2026-11-19T00:05:00Z")).status).toBe("updated")
    const octFinal = { ...store.cycles.get(OCT19_ISO)! }
    expect(octFinal.team_spend_cents).toBe(3684.5)

    // Reset: the API now reports the Nov 19 cycle.
    expect((await snap(NOV19, "2026-11-19T01:05:00Z", { "alice@example.com": { spendCents: 50 }, "carol@example.com": { spendCents: 0 } })).status).toBe(
      "inserted"
    )
    // A late/stale response for October writes nothing.
    expect((await snap(OCT19, "2026-11-19T02:05:00Z", { "alice@example.com": { spendCents: 999999 } })).status).toBe("stale")

    expect(store.cycles.get(OCT19_ISO)).toEqual(octFinal)
    expect(store.members.get(`${OCT19_ISO}|alice@example.com`)?.spend_cents).toBe(2450)

    const view = store.view()
    if (!view.available) throw new Error("expected available")
    expect(view.current).toMatchObject({ cycleStart: NOV19_ISO, teamSpendCents: 50, cycleEndEstimated: true })
    expect(view.previous).toEqual([
      expect.objectContaining({
        cycleStart: OCT19_ISO,
        cycleEnd: NOV19_ISO, // exact: the next cycle's start
        cycleEndEstimated: false,
        teamSpendCents: 3684.5,
        capturedAt: "2026-11-19T00:05:00.000Z",
      }),
    ])
    // Only the current cycle's members are listed per member.
    expect(view.current!.members.map((m) => [m.email, m.spendCents])).toEqual([
      ["alice@example.com", 50],
      ["bob@example.com", 0],
      ["carol@example.com", 0],
    ])
  })
})

/** Read client whose every table answers with `error`. */
function erroringReader(error: { code: string; message: string }): ReadClient {
  const q = {
    order: () => q,
    eq: () => q,
    then: (resolve: (v: { data: null; error: unknown }) => void) => resolve({ data: null, error }),
  }
  return { from: () => ({ select: () => q as never }) }
}

describe("missing-table fallback (migration 025 not applied)", () => {
  test("the snapshot reports migration_missing and does not throw", async () => {
    const { client } = fakeRpc(() => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.record_cursor_spend_snapshot" },
    }))
    const result = await snapshotCursorSpend(client, { apiKey: "k", fetchPages: async () => [spendPage(OCT19)] })
    expect(result).toMatchObject({ status: "migration_missing", reason: MIGRATION_025_MESSAGE })
  })

  test("the read returns a notice instead of an error", async () => {
    for (const error of [
      { code: "PGRST205", message: "Could not find the table 'public.cursor_spend_cycles' in the schema cache" },
      { code: "42P01", message: 'relation "cursor_spend_cycles" does not exist' },
    ]) {
      await expect(readCursorCycleSpend(erroringReader(error))).resolves.toEqual({ available: false, notice: MIGRATION_025_MESSAGE })
    }
    await expect(readCursorCycleSpend(erroringReader({ code: "XX000", message: "boom" }))).rejects.toMatchObject({ message: "boom" })
  })

  test("only missing-schema errors count as missing", () => {
    expect(isMissingCursorSpendSchema({ code: "PGRST205" })).toBe(true)
    expect(isMissingCursorSpendSchema({ message: 'relation "public.cursor_member_cycle_spend" does not exist' })).toBe(true)
    expect(isMissingCursorSpendSchema({ code: "23505", message: "duplicate key" })).toBe(false)
  })

  test("an RPC failure never throws", async () => {
    const client: RpcClient = { rpc: () => Promise.reject(new Error("network down")) }
    const snap = buildCursorSpendSnapshot([spendPage(OCT19)], new Date())!
    await expect(persistCursorSpendSnapshot(client, snap)).resolves.toMatchObject({ status: "error", reason: "network down" })
  })
})

describe("usage-event history, calendar-month and product semantics are unchanged", () => {
  const ctx = { userId: "u", providerId: "prov-cursor", teamId: "t" }
  const ev = (iso: string, email: string | undefined, model: string, cents: number, kind = "Usage-based") => ({
    timestamp: String(Date.parse(iso)),
    userEmail: email,
    model,
    kind,
    chargedCents: cents,
  })
  // Spans the Oct 19 cycle and the Oct / Nov calendar months.
  const events = [
    ev("2026-11-02T10:00:00Z", "alice@example.com", "claude-4-sonnet", 300),
    ev("2026-11-02T11:00:00Z", "alice@example.com", "claude-4-sonnet", 700, "Included in Business"),
    ev("2026-11-03T10:00:00Z", undefined, "github_bugbot", 200),
    ev("2026-11-20T10:00:00Z", "bob@example.com", "grok-bot-1", 150),
  ]

  test("collector rows do not depend on /teams/spend snapshots", () => {
    const plain = transform(events, ctx)
    const annotated = transform(events, ctx, { spendCents: { "alice@example.com": 2450 }, overallSpendCents: { "alice@example.com": 9450 } })
    const strip = (rs: typeof plain) => rs.map(({ metadata, ...r }) => ({ ...r, kinds: metadata.kinds, billing_tier: metadata.billing_tier }))
    expect(strip(annotated)).toEqual(strip(plain))

    // Calendar-month (November) on-demand total from usage events: included is $0.
    const nov = plain.filter((r) => r.timestamp.startsWith("2026-11")).reduce((s, r) => s + r.cost_usd, 0)
    expect(Math.round(nov * 100) / 100).toBe(6.5)

    // By-product split from usage events.
    const split = splitCursorByProduct(plain.map((r) => ({ model_name: r.model_name, total_cost_usd: r.cost_usd })))
    expect(Object.fromEntries(split.products.map((p) => [p.product, p.cost]))).toEqual({ grok_bot: 1.5, bugbot: 2, agent_chat: 3 })
  })

  test("the Cursor post-collect snapshot leaves the stored records untouched and writes only through the RPC", async () => {
    const records = transform(events, ctx)
    const before = JSON.parse(JSON.stringify(records))
    const fromCalls: string[] = []
    const { client, calls } = fakeRpc(() => ({ data: "inserted", error: null }))
    const admin = { rpc: client.rpc, from: (t: string) => (fromCalls.push(t), {}) } as unknown as SupabaseClient
    const original = global.fetch
    global.fetch = jest.fn(async () => new Response(JSON.stringify(spendPage(OCT19)), { status: 200 })) as typeof fetch
    try {
      const out = await POST_COLLECT_SYNC.cursor(admin, { providerId: "prov-cursor", apiKey: "k", teamId: "t", records })
      expect(out).toMatchObject({ cycle_spend: { status: "inserted", team_spend_cents: 3684.5 } })
    } finally {
      global.fetch = original
    }
    expect(records).toEqual(before)
    expect(fromCalls).toEqual([])
    expect(calls.map((c) => c.fn)).toEqual(["record_cursor_spend_snapshot"])
  })
})
