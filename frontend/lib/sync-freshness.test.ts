import fs from "fs"
import path from "path"
import {
  chicagoMonthAndDay,
  computeFreshness,
  cronSchedulesByProvider,
  formatChicago,
  formatRelative,
  freshnessDetail,
  freshnessLabel,
  previousRun,
  providerFreshness,
  type CronEntry,
  type FreshnessProvider,
} from "./sync-freshness"

const crons = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "vercel.json"), "utf8")) as { crons: CronEntry[] }
).crons
const schedules = cronSchedulesByProvider(crons)

const api = (name: string, last: string | null): FreshnessProvider => ({
  id: `id-${name}`,
  name,
  display_name: name,
  last_collected_at: last,
  metadata: { collection_method: "api" },
})
const manual = (name: string, last: string | null = null): FreshnessProvider => ({
  id: `id-${name}`,
  name,
  display_name: name === "chatgpt" ? "ChatGPT Business" : name,
  last_collected_at: last,
  metadata: { collection_method: "manual" },
})

// Nov 4 2026, 9:00 AM CST (UTC-6; DST ended Nov 1).
const NOV4_9AM_CT = new Date("2026-11-04T15:00:00Z")

describe("vercel.json schedules", () => {
  it("maps /api/cron/<slug> to its schedule", () => {
    expect(schedules.get("openai")).toBe("30 8 * * *")
    expect(schedules.get("anthropic")).toBe("0 8 * * *")
    expect(schedules.has("windsurf")).toBe(false)
  })
})

describe("previousRun", () => {
  it("finds the latest daily run at or before a time (UTC)", () => {
    expect(previousRun("30 8 * * *", new Date("2026-11-04T15:00:00Z"))?.toISOString()).toBe("2026-11-04T08:30:00.000Z")
    expect(previousRun("30 8 * * *", new Date("2026-11-04T08:29:00Z"))?.toISOString()).toBe("2026-11-03T08:30:00.000Z")
  })

  it("handles steps, lists and day-of-week", () => {
    expect(previousRun("*/15 * * * *", new Date("2026-11-04T15:07:30Z"))?.toISOString()).toBe("2026-11-04T15:00:00.000Z")
    expect(previousRun("0 6,18 * * *", new Date("2026-11-04T17:00:00Z"))?.toISOString()).toBe("2026-11-04T06:00:00.000Z")
    // 2026-11-04 is a Wednesday; the last Monday 09:00 is Nov 2.
    expect(previousRun("0 9 * * 1", new Date("2026-11-04T15:00:00Z"))?.toISOString()).toBe("2026-11-02T09:00:00.000Z")
  })

  it("returns null for an unparseable schedule", () => {
    expect(previousRun("not a cron", NOV4_9AM_CT)).toBeNull()
    expect(previousRun("61 * * * *", NOV4_9AM_CT)).toBeNull()
  })
})

describe("providerFreshness states", () => {
  it("fresh: synced after the most recent scheduled run", () => {
    const f = providerFreshness(api("anthropic", "2026-11-04T08:55:00Z"), schedules.get("anthropic")!, false, { now: NOV4_9AM_CT })
    expect(f.state).toBe("fresh")
    expect(f.warning).toBe(false)
    expect(f.expectedRunAt).toBe("2026-11-04T08:00:00.000Z")
  })

  it("fresh: a run that fires early in its hour (Vercel Hobby) still counts", () => {
    const f = providerFreshness(api("openai", "2026-11-04T08:05:00Z"), "30 8 * * *", false, { now: NOV4_9AM_CT })
    expect(f.state).toBe("fresh")
  })

  it("fresh: today's run is not missed until its grace period passes", () => {
    // 8:45 UTC: today's 8:30 run is within grace, yesterday's ran.
    const f = providerFreshness(api("openai", "2026-11-03T08:40:00Z"), "30 8 * * *", false, {
      now: new Date("2026-11-04T08:45:00Z"),
    })
    expect(f.state).toBe("fresh")
    expect(f.expectedRunAt).toBe("2026-11-03T08:30:00.000Z")
  })

  it("stale (missed cron): issue #47, OpenAI missed the Nov 4 2:30 AM CT sync after a manual pull on Nov 3", () => {
    const f = providerFreshness(api("openai", "2026-11-03T15:56:00Z"), schedules.get("openai")!, false, { now: NOV4_9AM_CT })
    expect(f.state).toBe("stale")
    expect(f.warning).toBe(true)
    expect(f.expectedRunAt).toBe("2026-11-04T08:30:00.000Z")
    expect(freshnessLabel(f, NOV4_9AM_CT)).toBe("Missed sync")
    expect(freshnessDetail(f, NOV4_9AM_CT)).toBe(
      "openai missed its Nov 4, 2:30 AM CST sync. Last synced Nov 3, 9:56 AM CST (23h ago)."
    )
  })

  it("stale: last sync older than the cron interval + grace", () => {
    const f = providerFreshness(api("cursor", "2026-11-02T08:45:00Z"), "40 8 * * *", false, { now: NOV4_9AM_CT })
    expect(f.state).toBe("stale")
  })

  it("never-synced: an API provider with no last_collected_at", () => {
    const f = providerFreshness(api("cursor", null), schedules.get("cursor")!, false, { now: NOV4_9AM_CT })
    expect(f.state).toBe("never")
    expect(f.warning).toBe(true)
    expect(f.lastSyncedAt).toBeNull()
    expect(freshnessLabel(f, NOV4_9AM_CT)).toBe("Never synced")
  })

  it("manual-missing: ChatGPT has no entry for the current month after day 3 (CT)", () => {
    const f = providerFreshness(manual("chatgpt"), null, false, { now: NOV4_9AM_CT })
    expect(f.state).toBe("manual_missing")
    expect(f.warning).toBe(true)
    expect(freshnessLabel(f, NOV4_9AM_CT)).toBe("No Nov entry")
    expect(freshnessDetail(f, NOV4_9AM_CT)).toBe(
      "ChatGPT Business has no November 2026 entry yet. Add it in Admin > Monthly entry."
    )
  })

  it("manual: no reminder through day 3 in America/Chicago, even when UTC is already day 4", () => {
    // 2026-11-04T04:00Z is Nov 3, 10:00 PM CST.
    const f = providerFreshness(manual("chatgpt"), null, false, { now: new Date("2026-11-04T04:00:00Z") })
    expect(f.state).toBe("manual_ok")
    expect(f.warning).toBe(false)
  })

  it("manual: no reminder once the month has an entry", () => {
    const f = providerFreshness(manual("chatgpt", "2026-11-02T16:00:00Z"), null, true, { now: NOV4_9AM_CT })
    expect(f.state).toBe("manual_ok")
    expect(f.lastSyncedAt).toBe("2026-11-02T16:00:00.000Z")
  })

  it("unscheduled: an API provider with a sync but no cron", () => {
    const f = providerFreshness(api("legacy", "2026-11-01T00:00:00Z"), null, false, { now: NOV4_9AM_CT })
    expect(f.state).toBe("unscheduled")
    expect(f.warning).toBe(false)
  })
})

describe("computeFreshness", () => {
  it("covers cron and manual providers only, in input order", () => {
    const providers = [
      api("anthropic", "2026-11-04T08:55:00Z"),
      manual("chatgpt"),
      manual("claude-max"),
      api("claude-ai", "2026-11-04T09:10:00Z"),
      api("cursor", "2026-11-04T09:00:00Z"),
      api("openai", "2026-11-03T15:56:00Z"),
      api("vercel-ai-gateway", null),
      api("windsurf", null), // removed collector: no cron, never synced
    ]
    const out = computeFreshness(
      { providers, crons, manualEntryThisMonth: new Set(["id-claude-max"]) },
      { now: NOV4_9AM_CT }
    )
    expect(out.map((f) => [f.slug, f.state])).toEqual([
      ["anthropic", "fresh"],
      ["chatgpt", "manual_missing"],
      ["claude-max", "manual_ok"],
      ["claude-ai", "fresh"],
      ["cursor", "fresh"],
      ["openai", "stale"],
      ["vercel-ai-gateway", "never"],
    ])
  })
})

describe("America/Chicago display", () => {
  it("formats in CST and CDT", () => {
    expect(formatChicago("2026-11-04T08:55:00Z")).toBe("Nov 4, 2:55 AM CST")
    expect(formatChicago("2026-10-15T13:00:00Z")).toBe("Oct 15, 8:00 AM CDT")
  })

  it("uses the Chicago calendar for month and day", () => {
    expect(chicagoMonthAndDay(new Date("2026-12-01T03:00:00Z"))).toEqual({ month: "2026-11", day: 30 })
    expect(chicagoMonthAndDay(NOV4_9AM_CT)).toEqual({ month: "2026-11", day: 4 })
  })

  it("formats relative times", () => {
    expect(formatRelative("2026-11-04T14:59:40Z", NOV4_9AM_CT)).toBe("just now")
    expect(formatRelative("2026-11-04T14:15:00Z", NOV4_9AM_CT)).toBe("45m ago")
    expect(formatRelative("2026-11-04T08:55:00Z", NOV4_9AM_CT)).toBe("6h ago")
    expect(formatRelative("2026-11-01T15:00:00Z", NOV4_9AM_CT)).toBe("3d ago")
  })
})
