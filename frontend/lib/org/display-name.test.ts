/**
 * @jest-environment node
 *
 * Default display names from firstname.lastname@liatrio.com (issue #66).
 */

import { FakeSupabase } from "./admin/testing/fake-supabase"
import { backfillDefaultDisplayNames, defaultDisplayName, isPlaceholderName, newPersonDisplayName } from "./display-name"
import { ensurePeople } from "./sync-helpers"
import type { SupabaseClient } from "@supabase/supabase-js"

describe("defaultDisplayName", () => {
  it("title-cases first.last@liatrio.com", () => {
    expect(defaultDisplayName("jane.doe@liatrio.com")).toBe("Jane Doe")
  })

  it("title-cases each hyphen segment", () => {
    expect(defaultDisplayName("mary-jane.smith@liatrio.com")).toBe("Mary-Jane Smith")
    expect(defaultDisplayName("ann.lee-park@liatrio.com")).toBe("Ann Lee-Park")
  })

  it("is case-insensitive and normalizes uppercase input", () => {
    expect(defaultDisplayName("JANE.DOE@LIATRIO.COM")).toBe("Jane Doe")
    expect(defaultDisplayName("McKay.O-NEIL@Liatrio.com")).toBe("Mckay O-Neil")
  })

  it.each([
    "jane.doe2@liatrio.com", // digits
    "jdoe@liatrio.com", // single part
    "jane.doe@example.com", // other domain
    "jane.doe@liatrio.io",
    "jane.van.doe@liatrio.com", // three parts
    "jane-.doe@liatrio.com",
    "",
    null,
  ])("returns null for %p", (email) => {
    expect(defaultDisplayName(email)).toBeNull()
  })
})

describe("isPlaceholderName / newPersonDisplayName", () => {
  const email = "jane.doe@liatrio.com"
  it("treats null, blank, the email and its local part as placeholders", () => {
    for (const n of [null, undefined, "", "   ", email, "Jane.Doe@Liatrio.com", "jane.doe", "JANE.DOE"]) {
      expect(isPlaceholderName(n, email)).toBe(true)
    }
    expect(isPlaceholderName("Jane", email)).toBe(false)
    expect(isPlaceholderName("J. Doe", email)).toBe(false)
  })

  it("keeps a real given name, else derives, else keeps the given value", () => {
    expect(newPersonDisplayName("Janie D", email)).toBe("Janie D")
    expect(newPersonDisplayName(null, email)).toBe("Jane Doe")
    expect(newPersonDisplayName("jane.doe", email)).toBe("Jane Doe")
    expect(newPersonDisplayName(null, "jdoe@liatrio.com")).toBeNull()
    expect(newPersonDisplayName("jdoe", "jdoe@liatrio.com")).toBe("jdoe")
  })
})

const person = (id: string, email: string, display_name: string | null) => ({ id, email, display_name, team_id: null, active: true })

describe("ensurePeople", () => {
  it("creates new people with the derived name and keeps a provider-supplied real name", async () => {
    const db = new FakeSupabase({ people: [] })
    const res = await ensurePeople(
      db as unknown as SupabaseClient,
      new Map<string, string | null>([
        ["jane.doe@liatrio.com", null],
        ["mary-jane.smith@liatrio.com", "mary-jane.smith"],
        ["bob.jones@liatrio.com", "Robert Jones"],
        ["jdoe@liatrio.com", null],
      ])
    )
    expect(res.created).toBe(4)
    const names = Object.fromEntries(db.table("people").map((p) => [p.email, p.display_name]))
    expect(names).toEqual({
      "jane.doe@liatrio.com": "Jane Doe",
      "mary-jane.smith@liatrio.com": "Mary-Jane Smith",
      "bob.jones@liatrio.com": "Robert Jones",
      "jdoe@liatrio.com": null,
    })
  })

  it("fills placeholder names of matched people and leaves manual names alone", async () => {
    const db = new FakeSupabase({
      people: [
        person("p1", "jane.doe@liatrio.com", "jane.doe"),
        person("p2", "bob.jones@liatrio.com", "Bobby"),
        person("p3", "ann.lee@liatrio.com", null),
      ],
    })
    const res = await ensurePeople(
      db as unknown as SupabaseClient,
      new Map<string, string | null>([
        ["jane.doe@liatrio.com", null],
        ["bob.jones@liatrio.com", null],
      ])
    )
    expect(res).toMatchObject({ created: 0, named: 1 })
    expect(db.table("people").map((p) => p.display_name)).toEqual(["Jane Doe", "Bobby", null])
  })
})

describe("backfillDefaultDisplayNames", () => {
  const seed = () =>
    new FakeSupabase({
      people: [
        person("p1", "jane.doe@liatrio.com", null),
        person("p2", "ann.lee@liatrio.com", "  "),
        person("p3", "mary-jane.smith@liatrio.com", "Mary-Jane.Smith@liatrio.com"),
        person("p4", "tom.hall@liatrio.com", "TOM.HALL"),
        person("p5", "bob.jones@liatrio.com", "Bobby J"),
        person("p6", "jdoe@liatrio.com", null),
        person("p7", "sam.ray@example.com", "sam.ray"),
      ],
    })

  it("replaces placeholder names only, never manual ones", async () => {
    const db = seed()
    expect(await backfillDefaultDisplayNames(db as unknown as SupabaseClient)).toBe(4)
    expect(db.table("people").map((p) => p.display_name)).toEqual([
      "Jane Doe",
      "Ann Lee",
      "Mary-Jane Smith",
      "Tom Hall",
      "Bobby J",
      null,
      "sam.ray",
    ])
  })

  it("is idempotent", async () => {
    const db = seed()
    await backfillDefaultDisplayNames(db as unknown as SupabaseClient)
    const after = db.table("people").map((p) => ({ ...p }))
    expect(await backfillDefaultDisplayNames(db as unknown as SupabaseClient)).toBe(0)
    expect(db.table("people")).toEqual(after)
  })

  it("does not overwrite a name changed after it was read", async () => {
    const db = seed()
    const stale = db.table("people").map((p) => ({ id: p.id as string, email: p.email as string, display_name: p.display_name as string | null }))
    db.table("people")[0].display_name = "Janie" // typed by an admin in the meantime
    expect(await backfillDefaultDisplayNames(db as unknown as SupabaseClient, stale)).toBe(3)
    expect(db.table("people")[0].display_name).toBe("Janie")
  })
})
