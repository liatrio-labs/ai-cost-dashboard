import type { ProviderGroup } from "./key-groups"
import {
  considerRevoking,
  DEFAULT_KEY_FILTER,
  filterGroups,
  filterKeys,
  isFiltered,
  keyActivity,
  keyCountText,
  keyStatus,
  matchesQuery,
  windowStart,
  type KeyFilter,
} from "./key-filter"

interface K {
  id: string
  name: string
  owner: string | null
  status: string | null
  spend: number
  spend90d: number
  lastSpend: string | null
  total_cost_usd: number
}

const key = (id: string, extra: Partial<K> = {}): K => ({
  id,
  name: `key ${id}`,
  owner: null,
  status: "active",
  spend: 0,
  spend90d: 0,
  lastSpend: null,
  total_cost_usd: extra.spend ?? 0,
  ...extra,
})
const fields = (k: K) => ({ spend: k.spend, status: k.status, text: [k.name, k.owner, k.id] })
const revokeFields = (k: K) => ({ status: k.status, spend90d: k.spend90d, lastSpend: k.lastSpend, label: k.name })
const f = (extra: Partial<KeyFilter> = {}): KeyFilter => ({ ...DEFAULT_KEY_FILTER, ...extra })

/**
 * The issue's numbers: 594 Anthropic keys, 475 with $0 in the last 90 days,
 * 252 of those still active. The period here is the 90-day window, so 119
 * keys have spend.
 */
function issueFixture(): K[] {
  const keys: K[] = []
  for (let i = 0; i < 119; i++) {
    const spend = i + 1
    keys.push(key(`spend-${i}`, { spend, spend90d: spend, lastSpend: "2026-10-30", status: i % 10 === 0 ? "inactive" : "active" }))
  }
  for (let i = 0; i < 252; i++) {
    // Half never spent, half last spent before the window.
    keys.push(key(`idle-${i}`, { status: "active", lastSpend: i % 2 ? "2026-03-01" : null }))
  }
  for (let i = 0; i < 150; i++) keys.push(key(`inactive-${i}`, { status: "inactive", lastSpend: "2026-01-15" }))
  for (let i = 0; i < 73; i++) keys.push(key(`archived-${i}`, { status: "archived" }))
  return keys
}

describe("keyStatus", () => {
  it("maps provider statuses to chips", () => {
    expect(keyStatus("active")).toBe("active")
    expect(keyStatus("ACTIVE")).toBe("active")
    expect(keyStatus("inactive")).toBe("inactive")
    expect(keyStatus("expired")).toBe("inactive")
    expect(keyStatus("archived")).toBe("deleted")
    expect(keyStatus("deleted")).toBe("deleted")
    expect(keyStatus(null)).toBe("unknown")
    expect(keyStatus("")).toBe("unknown")
  })
})

describe("matchesQuery", () => {
  it("matches name, owner or id, case-insensitive, every term", () => {
    const text = ["Pipeline prod", "alice@liatrio.com", "sk-ant-123"]
    expect(matchesQuery(text, "")).toBe(true)
    expect(matchesQuery(text, "  ")).toBe(true)
    expect(matchesQuery(text, "PIPE")).toBe(true)
    expect(matchesQuery(text, "alice")).toBe(true)
    expect(matchesQuery(text, "ant-123")).toBe(true)
    expect(matchesQuery(text, "pipeline alice")).toBe(true)
    expect(matchesQuery(text, "pipeline bob")).toBe(false)
    expect(matchesQuery([null, undefined], "x")).toBe(false)
  })
})

describe("filterKeys (issue #45)", () => {
  it("hides $0 keys by default and counts them: 119 of 594 keys with spend", () => {
    const keys = issueFixture()
    const r = filterKeys(keys, DEFAULT_KEY_FILTER, fields)
    expect(r.total).toBe(594)
    expect(r.withSpend).toBe(119)
    expect(r.keys).toHaveLength(119)
    expect(r.keys.every((k) => k.spend !== 0)).toBe(true)
    expect(keyCountText(r, DEFAULT_KEY_FILTER)).toBe("119 of 594 keys with spend")
  })

  it("show all lists every key", () => {
    const keys = issueFixture()
    const all = f({ showAll: true })
    const r = filterKeys(keys, all, fields)
    expect(r.keys).toHaveLength(594)
    expect(keyCountText(r, all)).toBe("594 keys")
    expect(r.statusCounts).toEqual({ active: 107 + 252, inactive: 12 + 150, deleted: 73, unknown: 0 })
  })

  it("keeps a refund (negative spend) as activity", () => {
    const r = filterKeys([key("a", { spend: -2 }), key("b")], DEFAULT_KEY_FILTER, fields)
    expect(r.keys.map((k) => k.id)).toEqual(["a"])
  })

  it("combines search and status chips with the spend filter", () => {
    const keys = [
      key("1", { name: "pipeline prod", owner: "alice@liatrio.com", spend: 5 }),
      key("2", { name: "pipeline dev", owner: "bob@liatrio.com", spend: 0 }),
      key("3", { name: "pipeline old", owner: "alice@liatrio.com", spend: 3, status: "inactive" }),
      key("4", { name: "chatbot", owner: "alice@liatrio.com", spend: 9 }),
      key("5", { name: "pipeline gone", owner: null, spend: 0, status: "archived" }),
      key("6", { name: "pipeline openai", owner: null, spend: 1, status: null }),
    ]
    const search = filterKeys(keys, f({ query: "pipeline" }), fields)
    expect(search.keys.map((k) => k.id)).toEqual(["1", "3", "6"])
    // Chip counts reflect spend + search, before the chip itself.
    expect(search.statusCounts).toEqual({ active: 1, inactive: 1, deleted: 0, unknown: 1 })

    const chip = filterKeys(keys, f({ query: "pipeline", status: "inactive" }), fields)
    expect(chip.keys.map((k) => k.id)).toEqual(["3"])
    expect(chip.statusCounts).toEqual(search.statusCounts)
    expect(keyCountText(chip, f({ status: "inactive" }))).toBe("1 of 6 keys with spend")

    const allDeleted = filterKeys(keys, f({ showAll: true, status: "deleted" }), fields)
    expect(allDeleted.keys.map((k) => k.id)).toEqual(["5"])
    expect(keyCountText(allDeleted, f({ showAll: true }))).toBe("1 of 6 keys")

    const owner = filterKeys(keys, f({ query: "alice", status: "active" }), fields)
    expect(owner.keys.map((k) => k.id)).toEqual(["1", "4"])
  })

  it("keeps the caller's sort order", () => {
    const keys = [key("z", { spend: 1 }), key("a", { spend: 9 }), key("m", { spend: 0 }), key("b", { spend: 4 })]
    expect(filterKeys(keys, DEFAULT_KEY_FILTER, fields).keys.map((k) => k.id)).toEqual(["z", "a", "b"])
    expect(filterKeys(keys, f({ showAll: true, query: "key" }), fields).keys.map((k) => k.id)).toEqual(["z", "a", "m", "b"])
  })

  it("isFiltered is false only for the default view", () => {
    expect(isFiltered(DEFAULT_KEY_FILTER)).toBe(false)
    expect(isFiltered(f({ showAll: true }))).toBe(true)
    expect(isFiltered(f({ query: "x" }))).toBe(true)
    expect(isFiltered(f({ status: "active" }))).toBe(true)
  })
})

describe("filterGroups", () => {
  it("drops empty groups and providers, recomputes subtotals, keeps order", () => {
    const a = key("a", { spend: 2 })
    const b = key("b", { spend: 0 })
    const c = key("c", { spend: 3 })
    const d = key("d", { spend: 0 })
    const group = (k: string, keys: K[]) => ({
      key: k,
      external_id: k,
      label: k,
      kind: "project" as const,
      registered_id: null,
      team_id: null,
      total_cost_usd: keys.reduce((s, x) => s + x.total_cost_usd, 0),
      keys,
    })
    const groups: ProviderGroup<K>[] = [
      { provider_id: "p1", provider_slug: "openai", label: "OpenAI", kind: "project", noun: "Project", total_cost_usd: 5, projects: [group("g1", [c, b]), group("g2", [a])] },
      { provider_id: "p2", provider_slug: "anthropic", label: "Anthropic", kind: "workspace", noun: "Workspace", total_cost_usd: 0, projects: [group("g3", [d])] },
    ]
    const kept = new Set(filterKeys([c, b, a, d], DEFAULT_KEY_FILTER, fields).keys)
    const out = filterGroups(groups, kept)
    expect(out.map((pg) => pg.provider_id)).toEqual(["p1"])
    expect(out[0].projects.map((g) => [g.key, g.keys.map((k) => k.id), g.total_cost_usd])).toEqual([
      ["g1", ["c"], 3],
      ["g2", ["a"], 2],
    ])
    expect(out[0].total_cost_usd).toBe(5)
    expect(filterGroups(groups, new Set([b]))[0].total_cost_usd).toBe(0)
  })
})

describe("keyActivity", () => {
  const now = new Date("2026-11-04T12:00:00Z")
  it("sums the last 90 days and finds the last spend date", () => {
    expect(windowStart(now)).toBe("2026-08-06")
    const act = keyActivity(
      [
        { key: "a", date: "2026-08-06", cost: 1 }, // first day of the window
        { key: "a", date: "2026-08-05", cost: 100 }, // just before it
        { key: "a", date: "2026-11-01T10:00:00Z", cost: 2 },
        { key: "a", date: "2026-11-03", cost: 0 }, // a $0 row is not a spend date
        { key: "b", date: "2026-01-01", cost: 5 },
        { key: "c", date: "2026-10-01", cost: 0 },
        { key: "d", date: "2026-12-01", cost: 7 }, // future, ignored
        { key: null, date: "2026-10-01", cost: 7 },
      ],
      now
    )
    expect(act.get("a")).toEqual({ spend: 3, lastSpend: "2026-11-01" })
    expect(act.get("b")).toEqual({ spend: 0, lastSpend: "2026-01-01" })
    expect(act.get("c")).toEqual({ spend: 0, lastSpend: null })
    expect(act.has("d")).toBe(false)
  })
})

describe("considerRevoking (issue #45)", () => {
  it("lists the 252 active keys with $0 in the last 90 days from the issue fixture", () => {
    const list = considerRevoking(issueFixture(), revokeFields)
    expect(list).toHaveLength(252)
    expect(list.every((k) => k.status === "active" && k.spend90d === 0)).toBe(true)
    // Never-spent first, then longest idle.
    expect(list.slice(0, 126).every((k) => k.lastSpend === null)).toBe(true)
    expect(list.slice(126).every((k) => k.lastSpend === "2026-03-01")).toBe(true)
  })

  it("excludes inactive, deleted and unknown-status keys, and keys with recent spend", () => {
    const keys = [
      key("old", { lastSpend: "2026-05-01" }),
      key("older", { lastSpend: "2026-02-01" }),
      key("never"),
      key("recent", { spend90d: 4, lastSpend: "2026-11-01" }),
      key("refund", { spend90d: -1, lastSpend: "2026-10-01" }),
      key("inactive", { status: "inactive" }),
      key("archived", { status: "archived" }),
      key("openai", { status: null }),
    ]
    expect(considerRevoking(keys, revokeFields).map((k) => k.id)).toEqual(["never", "older", "old"])
  })
})
