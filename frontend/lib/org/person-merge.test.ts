/**
 * Issue #51: likely-duplicate detection and merge preview (pure). The SQL
 * merge itself is checked in scripts/migration-tests/assertions_021.sql.
 */

import {
  emailLocalPart,
  findLikelyDuplicates,
  isMissing021,
  MergePlanError,
  normalizeName,
  parseMergeResult,
  planPersonMerge,
  type MergeOrg,
  type MergeSeatRow,
} from "./person-merge"

const PROV = [{ id: "pv-a", name: "anthropic" }, { id: "pv-c", name: "cursor" }, { id: "pv-m", name: "claude-max" }]

const org = (): MergeOrg => ({
  people: [
    { id: "j1", email: "jane@liatrio.com", display_name: "Jane Doe", team_id: null, active: true, created_at: "2026-01-01" },
    { id: "j2", email: "jane@liatrio.io", display_name: "Jane  Doe", team_id: "t-field", active: true, created_at: "2026-02-01" },
    { id: "j3", email: "j.doe@liatrio.com", display_name: "Jane Doé", team_id: null, active: false },
    { id: "s1", email: "sam.lee@liatrio.com", display_name: "Sam", team_id: null },
    { id: "s2", email: "samlee+cursor@gmail.com", display_name: null, team_id: null },
    { id: "x1", email: "alex@liatrio.com", display_name: "Alex", team_id: null },
    { id: "x2", email: "al@liatrio.com", display_name: "Al", team_id: null },
  ],
  identities: [
    { person_id: "j2", provider_id: "pv-a", external_id: "user_jane" },
    { person_id: "j2", provider_id: "pv-c", external_id: "jane@liatrio.io" },
    { person_id: "j1", provider_id: "pv-a", external_id: "user_jane_old" },
  ],
  apiKeys: [
    { id: "k1", owner_person_id: "j2" },
    { id: "k2", owner_person_id: "j1" },
  ],
  providers: PROV,
})

const seat = (id: string, email: string | null, extra: Record<string, unknown> = {}): MergeSeatRow => ({
  id,
  collection_method: "manual_entry",
  metadata: {
    entry_type: "monthly_seats",
    attribution: email ? { granularity: "person", person_email: email } : { granularity: "org" },
    ...extra,
  },
})

describe("duplicate detection (issue #51)", () => {
  it("normalizes names and email local-parts", () => {
    expect(normalizeName("  Jane   Doé ")).toBe("jane doe")
    expect(normalizeName("O'Brien, Pat")).toBe("o brien pat")
    expect(normalizeName(null)).toBe("")
    expect(emailLocalPart("Jane.Doe+cursor@Liatrio.com")).toBe("janedoe")
    expect(emailLocalPart("a@x.com")).toBe("")
    expect(emailLocalPart("")).toBe("")
  })

  it("groups same name or same email local-part, transitively, with a suggested primary", () => {
    const groups = findLikelyDuplicates(org())
    expect(groups.map((g) => g.members.map((m) => m.id))).toEqual([
      // All three normalize to "jane doe"; j1/j2 also share local part "jane".
      // Suggested primary first (j2: on a team), then the rest by email.
      ["j2", "j3", "j1"],
      ["s1", "s2"],
    ])
    const jane = groups[0]
    expect(jane.suggestedPrimaryId).toBe("j2") // active, on a team, most linked
    expect(jane.reasons).toEqual([
      { kind: "name", value: "jane doe" },
      { kind: "email_local_part", value: "jane" },
    ])
    expect(jane.members[0]).toEqual({
      id: "j2", email: "jane@liatrio.io", display_name: "Jane  Doe", team_id: "t-field", active: true, identities: 2, keys: 1,
    })
    expect(groups[1].reasons).toEqual([{ kind: "email_local_part", value: "samlee" }])
  })

  it("no groups when nobody collides", () => {
    expect(findLikelyDuplicates({ ...org(), people: org().people.filter((p) => p.id.startsWith("x")) })).toEqual([])
  })
})

describe("merge preview (issue #51)", () => {
  const seats = [
    seat("r1", "jane@liatrio.io"),
    seat("r2", " Jane@Liatrio.IO"),
    seat("r3", "jane@liatrio.com"),
    seat("r4", null),
    // Not a seat entry: plain manual row with the email; not moved.
    { id: "r5", collection_method: "manual_entry", metadata: { attribution: { granularity: "person", person_email: "jane@liatrio.io" } } },
  ]

  it("counts identities, owned keys, seat rows and aliases that would move", () => {
    const p = planPersonMerge(org(), seats, "j1", "j2")
    expect(p).toMatchObject({
      identities_moved: 2,
      keys_moved: 1,
      seat_rows_moved: 2,
      // cursor already maps jane@liatrio.io (the identity that moves), so no alias there.
      aliases_added: 2,
      team_adopted: true,
      display_name_adopted: false,
      result: { email: "jane@liatrio.com", display_name: "Jane Doe", team_id: "t-field", active: true },
    })
    expect(p.primary.id).toBe("j1")
    expect(p.secondary).toMatchObject({ id: "j2", identities: 2, keys: 1 })
  })

  it("adopts the secondary's name only when the primary has none", () => {
    const o = org()
    o.people.find((p) => p.id === "s2")!.display_name = "Samuel"
    const p = planPersonMerge(o, [], "s1", "s2")
    expect(p).toMatchObject({ display_name_adopted: false, result: { display_name: "Sam" } })
    const q = planPersonMerge(o, [], "s2", "s1")
    expect(q).toMatchObject({ display_name_adopted: false, aliases_added: 3, identities_moved: 0, keys_moved: 0 })
    o.people.find((p) => p.id === "s2")!.display_name = "  "
    expect(planPersonMerge(o, [], "s2", "s1")).toMatchObject({ display_name_adopted: true, result: { display_name: "Sam" } })
  })

  it("an inactive secondary doesn't deactivate the primary; two inactive stay inactive", () => {
    expect(planPersonMerge(org(), [], "j1", "j3").result.active).toBe(true)
    const o = org()
    o.people.find((p) => p.id === "j1")!.active = false
    expect(planPersonMerge(o, [], "j1", "j3").result.active).toBe(false)
  })

  it("refuses the same person twice and unknown ids", () => {
    expect(() => planPersonMerge(org(), [], "j1", "j1")).toThrow(MergePlanError)
    expect(() => planPersonMerge(org(), [], "nope", "j1")).toThrow("Primary person not found")
    expect(() => planPersonMerge(org(), [], "j1", "nope")).toThrow("Secondary person not found")
  })
})

describe("merge result and 021 detection", () => {
  it("parses merge_people()'s JSONB", () => {
    expect(
      parseMergeResult({ already_merged: true, primary_id: "a", secondary_id: "b", secondary_email: "b@x.com", identities_moved: "2", keys_moved: 1, seat_rows_moved: 0, aliases_added: 3, team_adopted: true, display_name_adopted: false, merged_at: "t" })
    ).toEqual({ already_merged: true, primary_id: "a", secondary_id: "b", secondary_email: "b@x.com", merged_at: "t", identities_moved: 2, keys_moved: 1, seat_rows_moved: 0, aliases_added: 3, team_adopted: true, display_name_adopted: false })
  })

  it("recognizes a missing person_merges table or merge_people function", () => {
    expect(isMissing021({ code: "PGRST205", message: "Could not find the table 'public.person_merges' in the schema cache" })).toBe(true)
    expect(isMissing021({ code: "PGRST202", message: "Could not find the function public.merge_people" })).toBe(true)
    expect(isMissing021({ code: "42P01", message: 'relation "person_merges" does not exist' })).toBe(true)
    expect(isMissing021({ code: "P0001", message: "merge_people: secondary person x not found" })).toBe(false)
    expect(isMissing021(null)).toBe(false)
  })
})
