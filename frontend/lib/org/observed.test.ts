import { listApiKeys, monthBounds, observedPeople, unassignedQueue } from "./observed"
import { novemberRecords } from "./observed-fixtures"
import { orgSchemas } from "./schemas"
import { D, K, P, PE, T, orgData } from "./test-fixtures"

describe("unassignedQueue", () => {
  it("groups no-team spend by person email, API key and project, with reconciling totals", () => {
    const q = unassignedQueue(novemberRecords(), orgData())
    expect(q.total_cost_usd).toBe(42.5)
    expect(q.assigned_cost_usd).toBe(16)
    expect(q.unassigned_cost_usd).toBe(26.5)
    expect(q.groups.map((g) => [g.kind, g.key, g.total_cost_usd, g.record_count, g.assignable])).toEqual([
      ["other", "other", 8.5, 2, false],
      ["person", "person:carol@liatrio.com", 7.5, 2, true],
      ["person", "person:zed@liatrio.com", 4, 1, true],
      ["api_key", `api_key:${P.openai}:key_bare`, 3, 1, true],
      ["api_key", `api_key:${P.openai}:key_new`, 2, 1, true],
      ["project", `project:${P.openai}:proj_1`, 1.5, 1, false],
    ])
    const sum = q.groups.reduce((s, g) => s + g.total_cost_usd, 0)
    expect(sum).toBeCloseTo(q.unassigned_cost_usd, 6)

    const carol = q.groups.find((g) => g.email === "carol@liatrio.com")!
    expect(carol.person_id).toBe(PE.carol)
    expect(carol.provider_ids).toEqual([P.anthropic, P.cursor].sort())
    const zed = q.groups.find((g) => g.email === "zed@liatrio.com")!
    expect(zed).toMatchObject({ person_id: null, label: "Zed" })
    expect(q.groups.find((g) => g.external_key_id === "key_bare")!.label).toBe("Unowned key")
    expect(q.groups.find((g) => g.external_key_id === "key_new")!.label).toBe("CI key")
    expect(q.groups.find((g) => g.kind === "project")!.label).toBe("Research")
  })

  it("is empty when every row resolves to a team", () => {
    const q = unassignedQueue(novemberRecords().slice(0, 1), orgData())
    expect(q).toMatchObject({ total_cost_usd: 10, assigned_cost_usd: 10, unassigned_cost_usd: 0, groups: [] })
  })
})

describe("observedPeople", () => {
  it("lists distinct normalized emails and flags existing people", () => {
    const people = observedPeople(novemberRecords(), orgData())
    expect(people.map((p) => [p.email, p.existing_person_id, p.record_count])).toEqual([
      ["alice@liatrio.com", PE.alice, 1],
      ["carol@liatrio.com", PE.carol, 2],
      ["zed@liatrio.com", null, 1],
    ])
    expect(people[2]).toMatchObject({ name: "Zed", total_cost_usd: 4 })
  })
})

describe("listApiKeys", () => {
  it("merges observed keys with registered keys", () => {
    const keys = listApiKeys(novemberRecords(), orgData())
    const byId = Object.fromEntries(keys.map((k) => [k.external_key_id, k]))
    expect(Object.keys(byId).sort()).toEqual(["key_bare", "key_new", "key_owner", "key_team"])
    expect(byId.key_team).toMatchObject({ id: K.team, registered: true, observed: true, team_id: T.data, total_cost_usd: 6 })
    expect(byId.key_owner).toMatchObject({ registered: true, observed: false, record_count: 0 })
    expect(byId.key_new).toMatchObject({ id: null, registered: false, observed: true, name: "CI key" })
  })
})

describe("monthBounds", () => {
  it("spans the UTC month, including December rollover", () => {
    expect(monthBounds("2026-12")).toEqual({ start: "2026-12-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" })
  })
})

describe("orgSchemas", () => {
  const s = orgSchemas(orgData())

  it("rejects a duplicate team name in the same department (case-insensitive)", () => {
    const r = s.teamCreate.safeParse({ name: " platform ", department_id: D.eng })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0].message).toMatch(/already exists in this department/)
  })

  it("allows the same team name in another department", () => {
    expect(s.teamCreate.safeParse({ name: "Platform", department_id: D.sales }).success).toBe(true)
  })

  it("rejects moving a team into a department that already has that name", () => {
    expect(s.teamUpdate(T.field).safeParse({ name: "Platform", department_id: D.eng }).success).toBe(false)
    expect(s.teamUpdate(T.data).safeParse({ name: "Platform" }).success).toBe(false)
    expect(s.teamUpdate(T.platform).safeParse({ name: "Platform" }).success).toBe(true)
  })

  it("rejects an invalid email", () => {
    const r = s.personCreate.safeParse({ email: "not-an-email" })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0].message).toBe("Invalid email address")
  })

  it("rejects an unknown team id", () => {
    const r = s.personCreate.safeParse({ email: "new@liatrio.com", team_id: "team-nope" })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0].message).toBe("Unknown team id")
    expect(s.apiKeyAssign.safeParse({ provider_id: P.openai, external_key_id: "k", team_id: "team-nope" }).success).toBe(false)
  })

  it("rejects an unknown department id and a duplicate email", () => {
    expect(s.teamCreate.safeParse({ name: "New", department_id: "dept-nope" }).success).toBe(false)
    expect(s.personCreate.safeParse({ email: "ALICE@liatrio.com" }).success).toBe(false)
  })

  it("normalizes email and treats empty team id as none", () => {
    const r = s.personCreate.parse({ email: "  New@Liatrio.COM ", team_id: "" })
    expect(r).toMatchObject({ email: "new@liatrio.com", team_id: null })
  })
})
