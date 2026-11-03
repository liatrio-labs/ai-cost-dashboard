/**
 * Every cron in vercel.json must point at an existing App Router route file,
 * so a leftover cron for a removed collector (issue #27) fails CI instead of
 * erroring nightly in production.
 */

import fs from "fs"
import path from "path"

const root = path.resolve(__dirname, "..")
const config = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")) as {
  crons?: Array<{ path: string; schedule: string }>
}
const crons = config.crons ?? []

describe("vercel.json crons", () => {
  it("defines at least one cron", () => {
    expect(crons.length).toBeGreaterThan(0)
  })

  it.each(crons.map((c) => [c.path]))("%s has a route file", (cronPath) => {
    const pathname = cronPath.split("?")[0].replace(/^\/+/, "")
    const dir = path.join(root, "app", pathname)
    const found = ["route.ts", "route.js"].some((f) => fs.existsSync(path.join(dir, f)))
    expect(found).toBe(true)
  })

  it("has no duplicate paths", () => {
    const paths = crons.map((c) => c.path)
    expect(new Set(paths).size).toBe(paths.length)
  })
})
