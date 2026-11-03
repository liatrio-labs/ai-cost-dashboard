import {
  identityCreateSchema,
  importSchema,
  keyAssignSchema,
  personCreateSchema,
  personUpdateSchema,
  teamCreateSchema,
  teamUpdateSchema,
  unassignedAssignSchema,
  type OrgSnapshot,
} from "./schemas"
import { D, P, PE, T, orgData } from "../test-fixtures"

function snapshot(): OrgSnapshot {
  const o = orgData()
  return {
    ...o,
    identities: o.identities.map((i, n) => ({ id: `i${n}`, ...i })),
    projects: o.projects ?? [],
    providers: [
      { id: P.anthropic, name: "anthropic" },
      { id: P.openai, name: "openai" },
      { id: P.cursor, name: "cursor" },
    ],
  }
}

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.message)

describe("zod validation rejects bad input", () => {
  const org = snapshot()

  it("duplicate team name in a department (case-insensitive), including no department", () => {
    expect(messages(teamCreateSchema(org).safeParse({ name: "DATA", department_id: D.eng }))).toEqual([
      'A team named "DATA" already exists in Engineering',
    ])
    expect(messages(teamCreateSchema(org).safeParse({ name: "orphan" }))).toEqual([
      'A team named "orphan" already exists without a department',
    ])
    expect(teamCreateSchema(org).safeParse({ name: "Data", department_id: D.sales }).success).toBe(true)
  })

  it("renaming or moving a team into a clash", () => {
    expect(messages(teamUpdateSchema(org, T.platform).safeParse({ name: "Data" }))).toEqual([
      'A team named "Data" already exists in Engineering',
    ])
    // Renaming a team to its own name is fine.
    expect(teamUpdateSchema(org, T.platform).safeParse({ name: "Platform" }).success).toBe(true)
  })

  it("invalid email", () => {
    for (const email of ["", "nope", "a@", "@b.com", "a b@c.com"]) {
      expect(personCreateSchema(org).safeParse({ email }).success).toBe(false)
    }
    expect(messages(personCreateSchema(org).safeParse({ email: "nope" }))).toEqual(["Invalid email address"])
    expect(importSchema(org).safeParse({ confirm: true, emails: ["ok@liatrio.com", "bad"] }).success).toBe(false)
  })

  it("unknown team id", () => {
    expect(messages(personCreateSchema(org).safeParse({ email: "new@liatrio.com", team_id: "team-x" }))).toEqual([
      "Unknown team id: team-x",
    ])
    expect(messages(personUpdateSchema(org, PE.carol).safeParse({ team_id: "team-x" }))).toEqual([
      "Unknown team id: team-x",
    ])
    expect(
      messages(keyAssignSchema(org).safeParse({ provider_id: P.openai, external_key_id: "k", team_id: "team-x" }))
    ).toEqual(["Unknown team id: team-x"])
    expect(
      messages(unassignedAssignSchema(org).safeParse({ kind: "person", email: "a@liatrio.com", team_id: "team-x" }))
    ).toEqual(["Unknown team id: team-x"])
  })

  it("unknown keys, missing names and blank ids", () => {
    expect(teamCreateSchema(org).safeParse({ name: "X", dept: D.eng }).success).toBe(false)
    expect(messages(teamCreateSchema(org).safeParse({ name: "   " }))).toEqual(["Name is required"])
    expect(
      identityCreateSchema(org).safeParse({ person_id: PE.carol, provider_id: P.openai, external_id: "  " }).success
    ).toBe(false)
  })

  it("accepts and normalizes valid input", () => {
    expect(personCreateSchema(org).parse({ email: " New@Liatrio.COM ", team_id: T.data })).toEqual({
      email: "new@liatrio.com",
      team_id: T.data,
    })
    expect(teamUpdateSchema(org, T.data).parse({ department_id: null })).toEqual({ department_id: null })
  })
})
