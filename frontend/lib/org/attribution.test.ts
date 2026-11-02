import { buildOrgIndex, getAttribution, normalizeEmail, resolveAttribution } from "./attribution"
import { D, K, P, PE, T, orgData } from "./test-fixtures"

const index = buildOrgIndex(orgData())
const resolve = (provider_id: string, attribution?: unknown) =>
  resolveAttribution(
    { provider_id, metadata: attribution === undefined ? {} : { attribution } },
    index
  )

const UNASSIGNED = {
  person_id: null,
  org_api_key_id: null,
  team_id: null,
  department_id: null,
}

describe("resolveAttribution: person", () => {
  it("1a: person_email matches people.email, case-insensitive and trimmed", () => {
    expect(resolve(P.anthropic, { person_email: "  ALICE@Liatrio.com ", granularity: "person" })).toEqual({
      person_id: PE.alice,
      org_api_key_id: null,
      team_id: T.platform,
      department_id: D.eng,
      project_id: null,
      workspace_id: null,
      granularity: "person",
    })
  })

  it("1b: falls back to (provider, person_external_id) in identities", () => {
    expect(resolve(P.anthropic, { person_external_id: "user_bob", granularity: "person" })).toMatchObject({
      person_id: PE.bob,
      team_id: T.field,
      department_id: D.sales,
    })
  })

  it("1b: identities are per provider", () => {
    expect(resolve(P.openai, { person_external_id: "user_bob", granularity: "person" })).toMatchObject(UNASSIGNED)
  })

  it("1c: falls back to (provider, person_email) in identities", () => {
    expect(resolve(P.cursor, { person_email: "Dave.Alias@liatrio.com", granularity: "person" })).toMatchObject({
      person_id: PE.dave,
      team_id: T.data,
      department_id: D.eng,
    })
  })

  it("1a beats 1b: people.email wins over person_external_id", () => {
    expect(
      resolve(P.anthropic, { person_email: "alice@liatrio.com", person_external_id: "user_bob", granularity: "person" })
    ).toMatchObject({ person_id: PE.alice })
  })

  it("1b beats 1c: external id identity wins over email identity", () => {
    const idx = buildOrgIndex({
      ...orgData(),
      identities: [
        { person_id: PE.bob, provider_id: P.cursor, external_id: "u1" },
        { person_id: PE.dave, provider_id: P.cursor, external_id: "someone@else.com" },
      ],
    })
    expect(
      resolveAttribution(
        { provider_id: P.cursor, metadata: { attribution: { person_email: "someone@else.com", person_external_id: "u1", granularity: "person" } } },
        idx
      ).person_id
    ).toBe(PE.bob)
  })

  it("1d: falls back to the API key owner", () => {
    expect(resolve(P.openai, { api_key_id: "key_owner", granularity: "api_key" })).toMatchObject({
      person_id: PE.bob,
      org_api_key_id: K.owner,
    })
  })

  it("1c beats 1d: a resolved person wins over the key owner", () => {
    expect(
      resolve(P.openai, { person_email: "bob@liatrio.com", api_key_id: "key_team", granularity: "api_key" })
    ).toMatchObject({ person_id: PE.bob, org_api_key_id: K.team })
  })

  it("1e: unknown email, id and key resolve to no person", () => {
    expect(
      resolve(P.openai, { person_email: "ghost@example.com", person_external_id: "nope", api_key_id: "key_missing", granularity: "api_key" })
    ).toMatchObject({ ...UNASSIGNED, granularity: "api_key" })
  })
})

describe("resolveAttribution: team and department", () => {
  it("2a: the key's team beats the person's team", () => {
    expect(
      resolve(P.openai, { person_email: "bob@liatrio.com", api_key_id: "key_team", granularity: "api_key" })
    ).toMatchObject({ person_id: PE.bob, team_id: T.data, department_id: D.eng })
  })

  it("2a: key-only row uses the key's team even though the owner is on another team", () => {
    expect(resolve(P.openai, { api_key_id: "key_team", granularity: "api_key" })).toMatchObject({
      person_id: PE.alice,
      team_id: T.data,
      department_id: D.eng,
    })
  })

  it("2b: key without a team falls back to the owner's team", () => {
    expect(resolve(P.openai, { api_key_id: "key_owner", granularity: "api_key" })).toMatchObject({
      team_id: T.field,
      department_id: D.sales,
    })
  })

  it("2c: person without a team leaves team and department Unassigned", () => {
    expect(resolve(P.anthropic, { person_email: "carol@liatrio.com", granularity: "person" })).toMatchObject({
      person_id: PE.carol,
      team_id: null,
      department_id: null,
    })
  })

  it("2c: registered key with no owner or team keeps the key only", () => {
    expect(resolve(P.openai, { api_key_id: "key_bare", project_id: "proj_1", granularity: "project" })).toEqual({
      ...UNASSIGNED,
      org_api_key_id: K.bare,
      project_id: "proj_1",
      workspace_id: null,
      granularity: "project",
    })
  })

  it("3: team without a department leaves department Unassigned", () => {
    expect(resolve(P.anthropic, { person_email: "erin@liatrio.com", granularity: "person" })).toMatchObject({
      team_id: T.orphan,
      department_id: null,
    })
  })

  it("api_key_id only matches keys of the same provider", () => {
    expect(resolve(P.anthropic, { api_key_id: "key_team", workspace_id: "wrk_1", granularity: "workspace" })).toMatchObject({
      ...UNASSIGNED,
      workspace_id: "wrk_1",
      granularity: "workspace",
    })
  })
})

describe("resolveAttribution: missing or malformed attribution", () => {
  it.each([
    ["empty metadata", {}],
    ["null metadata", null],
    ["undefined metadata", undefined],
    ["legacy metadata without attribution", { member_email: "bob@liatrio.com" }],
    ["attribution is a string", { attribution: "bob@liatrio.com" }],
    ["attribution is an array", { attribution: [] }],
    ["attribution is null", { attribution: null }],
  ])("%s -> Unassigned, granularity org", (_label, metadata) => {
    expect(resolveAttribution({ provider_id: P.openai, metadata: metadata as never }, index)).toEqual({
      ...UNASSIGNED,
      project_id: null,
      workspace_id: null,
      granularity: "org",
    })
  })

  it("empty strings count as absent and an unknown granularity becomes org", () => {
    expect(resolve(P.openai, { person_email: "", api_key_id: "", project_id: "", granularity: "bogus" })).toEqual({
      ...UNASSIGNED,
      project_id: null,
      workspace_id: null,
      granularity: "org",
    })
  })

  it("missing granularity becomes org but attribution still resolves", () => {
    expect(resolve(P.anthropic, { person_email: "alice@liatrio.com" })).toMatchObject({
      person_id: PE.alice,
      granularity: "org",
    })
  })
})

describe("helpers", () => {
  it("normalizeEmail trims, lower-cases and nulls empties", () => {
    expect(normalizeEmail(" A@B.com ")).toBe("a@b.com")
    expect(normalizeEmail("   ")).toBeNull()
    expect(normalizeEmail(42)).toBeNull()
  })

  it("getAttribution normalizes fields", () => {
    expect(getAttribution({ attribution: { person_email: "X@Y.com", api_key_id: 7, granularity: "person" } })).toEqual({
      person_email: "x@y.com",
      person_external_id: null,
      person_name: null,
      api_key_id: null,
      api_key_name: null,
      project_id: null,
      project_name: null,
      workspace_id: null,
      granularity: "person",
    })
  })
})
