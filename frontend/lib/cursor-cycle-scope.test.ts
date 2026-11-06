/**
 * Issue #84: scoping Cursor billing-cycle on-demand to org filters, and its
 * freshness. Pure; no database.
 */

import {
  CYCLE_STALE_AFTER_MS,
  NOT_APPLICABLE,
  cycleFreshness,
  cycleQueryString,
  scopeCursorCycleView,
  sumSpendCents,
} from "./cursor-cycle-scope"
import type { CursorCycleMember, CursorCycleView } from "./cursor-spend"
import { orgData, P, PE, T } from "./org/test-fixtures"
import type { OrgData } from "./org/types"

const OCT19 = "2026-10-19T00:00:00.000Z"
const NOV19 = "2026-11-19T00:00:00.000Z"

const m = (email: string, name: string | null, spendCents: number | null, overallSpendCents: number | null = 999999): CursorCycleMember => ({
  email,
  name,
  role: "member",
  spendCents,
  overallSpendCents,
  monthlyLimitDollars: 100,
  hardLimitOverrideDollars: null,
  effectivePerUserLimitDollars: 100,
})

function view(members: CursorCycleMember[]): CursorCycleView {
  return {
    available: true,
    current: {
      cycleStart: OCT19,
      cycleEnd: NOV19,
      cycleEndEstimated: true,
      teamSpendCents: sumSpendCents(members) ?? 0,
      teamOverallSpendCents: 1,
      memberCount: members.length,
      capturedAt: "2026-11-06T17:05:00.000Z",
      firstCapturedAt: OCT19,
      members,
    },
    previous: [
      {
        cycleStart: "2026-09-19T00:00:00.000Z",
        cycleEnd: OCT19,
        cycleEndEstimated: false,
        teamSpendCents: 5000,
        teamOverallSpendCents: null,
        memberCount: 1,
        capturedAt: OCT19,
        firstCapturedAt: null,
      },
    ],
  }
}

function org(): OrgData {
  const o = orgData()
  o.people.push({ id: "p-jacob", email: "Jacob.LeCoq@liatrio.com ", display_name: "Jacob LeCoq", team_id: T.platform })
  o.identities = o.identities.filter((i) => i.provider_id === P.cursor)
  return o
}
const ctx = { org: org(), cursorProviderId: P.cursor }

const MEMBERS = [
  m("jacob.lecoq@liatrio.com", "Jacob Lecoq", 12000),
  m("dave.alias@liatrio.com", "Dave", 5000),
  m("alice@liatrio.com", "Alice", 10000),
  m("someone@example.com", "Jacob LeCoq", 342),
]

describe("scopeCursorCycleView (issue #84)", () => {
  it("matches a person by normalized email despite a display-name difference (Jacob LeCoq vs Jacob Lecoq)", () => {
    const out = scopeCursorCycleView(view(MEMBERS), { person: "p-jacob" }, ctx)
    if (!out.available || !out.current) throw new Error("expected a current cycle")
    expect(out.current.members.map((x) => x.email)).toEqual(["jacob.lecoq@liatrio.com"])
    expect(out.current.selectionSpendCents).toBe(12000)
    expect(out.scope).toEqual({ kind: "filtered", matchedMembers: 1 })
  })

  it("never matches by display name: a stranger named like the person is not theirs", () => {
    const out = scopeCursorCycleView(view([m("someone@example.com", "Jacob LeCoq", 342)]), { person: "p-jacob" }, ctx)
    if (!out.available || !out.current) throw new Error("expected a current cycle")
    expect(out.current.members).toEqual([])
    expect(out.current.selectionSpendCents).toBeNull()
  })

  it("matches through a Cursor person identity like Cursor usage events do", () => {
    const out = scopeCursorCycleView(view(MEMBERS), { person: PE.dave }, ctx)
    if (!out.available || !out.current) throw new Error("expected a current cycle")
    expect(out.current.members.map((x) => x.email)).toEqual(["dave.alias@liatrio.com"])
  })

  it("sums spendCents only, never overallSpendCents", () => {
    const out = scopeCursorCycleView(view([m("alice@liatrio.com", "Alice", 700, 50000)]), { person: PE.alice }, ctx)
    if (!out.available || !out.current) throw new Error("expected a current cycle")
    expect(out.current.selectionSpendCents).toBe(700)
    expect(sumSpendCents([{ spendCents: null }, { spendCents: null }])).toBeNull()
    expect(sumSpendCents([{ spendCents: null }, { spendCents: 0 }])).toBe(0)
  })

  it("selected Cursor tool (no org filter) is the whole team with earlier cycles kept", () => {
    const out = scopeCursorCycleView(view(MEMBERS), { provider: "cursor" }, ctx)
    if (!out.available || !out.current) throw new Error("expected a current cycle")
    expect(out.scope).toEqual({ kind: "team" })
    expect(out.current.members).toHaveLength(4)
    expect(out.current.selectionSpendCents).toBe(out.current.teamSpendCents)
    expect(out.previous).toHaveLength(1)
  })

  it("a filtered view drops team-level previous cycles and keeps the cycle dates and snapshot time", () => {
    const out = scopeCursorCycleView(view(MEMBERS), { team: T.platform }, ctx)
    if (!out.available || !out.current) throw new Error("expected a current cycle")
    expect(out.previous).toEqual([])
    expect(out.current).toMatchObject({ cycleStart: OCT19, cycleEnd: NOV19, capturedAt: "2026-11-06T17:05:00.000Z" })
    expect(out.current.members.map((x) => x.email).sort()).toEqual(["alice@liatrio.com", "jacob.lecoq@liatrio.com"])
  })

  it("filters that can't apply are not_applicable with a reason, not an empty or $0 total", () => {
    const cases: [Record<string, string>, string][] = [
      [{ provider: "openai" }, NOT_APPLICABLE.provider],
      [{ key: "k-team" }, NOT_APPLICABLE.key],
      [{ project: "proj_2" }, NOT_APPLICABLE.project],
      [{ person: "cursor-automation" }, NOT_APPLICABLE.automation],
    ]
    for (const [filters, reason] of cases) {
      expect(scopeCursorCycleView(view(MEMBERS), filters, ctx)).toEqual({
        available: true,
        scope: { kind: "not_applicable", reason },
        current: null,
        previous: [],
      })
    }
  })

  it("passes the migration notice through unchanged", () => {
    expect(scopeCursorCycleView({ available: false, notice: "x" }, { person: PE.alice }, ctx)).toEqual({ available: false, notice: "x" })
  })

  it("builds the cycle query from filters only, never the period", () => {
    expect(cycleQueryString({ person: PE.alice, provider: "cursor" })).toBe(`person=${PE.alice}&provider=cursor`)
    expect(cycleQueryString({})).toBe("")
  })
})

describe("cycleFreshness (issue #84)", () => {
  const cur = { capturedAt: "2026-11-06T17:05:00.000Z", cycleEnd: NOV19 }
  it("is fresh within the stale window", () => {
    expect(cycleFreshness(cur, new Date("2026-11-06T18:00:00Z"))).toEqual({ status: "fresh" })
  })
  it("is stale when the last snapshot is older than the window", () => {
    const later = new Date(Date.parse(cur.capturedAt) + CYCLE_STALE_AFTER_MS + 1)
    expect(cycleFreshness(cur, later)).toEqual({ status: "stale", reason: "old_snapshot" })
  })
  it("is stale once the cycle has reset without a new snapshot", () => {
    expect(cycleFreshness(cur, new Date("2026-11-19T00:30:00Z"))).toEqual({ status: "stale", reason: "cycle_ended" })
  })
  it("is stale when the snapshot time is unknown", () => {
    expect(cycleFreshness({ capturedAt: null, cycleEnd: NOV19 })).toEqual({ status: "stale", reason: "no_snapshot_time" })
  })
})
