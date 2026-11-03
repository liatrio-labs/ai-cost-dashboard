import { buildOrgIndex, getAttribution, normalizeEmail, resolveAttribution } from "./attribution"
import { D, K, P, PE, PR, T, orgData } from "./test-fixtures"

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

describe("resolveAttribution: project team fallback (011)", () => {
  it("project team applies when there is no key or person team", () => {
    expect(resolve(P.openai, { project_id: "proj_2", granularity: "project" })).toMatchObject({
      person_id: null,
      team_id: T.field,
      department_id: D.sales,
      project_id: "proj_2",
    })
  })

  it("person team beats project team", () => {
    expect(
      resolve(P.openai, { person_email: "alice@liatrio.com", project_id: "proj_2", granularity: "person" })
    ).toMatchObject({ person_id: PE.alice, team_id: T.platform })
  })

  it("person without a team falls back to the project team", () => {
    expect(
      resolve(P.openai, { person_email: "carol@liatrio.com", project_id: "proj_2", granularity: "person" })
    ).toMatchObject({ person_id: PE.carol, team_id: T.field })
  })

  it("project ids match per provider only, and unmapped projects stay Unassigned", () => {
    expect(resolve(P.anthropic, { project_id: "proj_2", granularity: "project" })).toMatchObject(UNASSIGNED)
    expect(resolve(P.openai, { project_id: "proj_1", granularity: "project" })).toMatchObject(UNASSIGNED)
  })
})

describe("resolveAttribution: issue #32 precedence (Anthropic keys and workspace projects)", () => {
  // Alice's key (auto-owned by the creator sync) in workspace wrk_res, whose project belongs to Data.
  const data = orgData()
  data.apiKeys.push({ id: "k-an", provider_id: P.anthropic, external_key_id: "an_alice", owner_person_id: PE.alice, team_id: null, assignment_source: "auto" })
  data.apiKeys.push({ id: "k-an-svc", provider_id: P.anthropic, external_key_id: "an_svc", owner_person_id: null, team_id: null, assignment_source: "auto" })
  data.projects!.push({ id: "pr-an", provider_id: P.anthropic, external_project_id: "wrk_res", name: "Research", team_id: T.data })
  const idx = buildOrgIndex(data)
  const r = (attribution: unknown) => resolveAttribution({ provider_id: P.anthropic, metadata: { attribution } }, idx)

  it("1: a user_actor row on a key owned by someone else resolves to the actor (and the actor's team)", () => {
    expect(
      r({ api_key_id: "an_alice", workspace_id: "wrk_res", project_id: "wrk_res", person_email: "bob@liatrio.com", person_external_id: "user_bob", granularity: "person" })
    ).toMatchObject({ person_id: PE.bob, team_id: T.field, org_api_key_id: "k-an", project_id: "wrk_res" })
  })

  it("3: an api_actor row resolves to the key's owner, whose team beats the workspace project's", () => {
    expect(r({ api_key_id: "an_alice", workspace_id: "wrk_res", project_id: "wrk_res", granularity: "api_key" })).toMatchObject({
      person_id: PE.alice,
      team_id: T.platform,
    })
  })

  it("4: a key with no owner falls back to the workspace project's team", () => {
    expect(r({ api_key_id: "an_svc", workspace_id: "wrk_res", project_id: "wrk_res", granularity: "api_key" })).toMatchObject({
      person_id: null,
      team_id: T.data,
      department_id: D.eng,
    })
  })

  it("5: no owner and an unmapped workspace is Unassigned", () => {
    expect(r({ api_key_id: "an_svc", workspace_id: "wrk_other", project_id: "wrk_other", granularity: "api_key" })).toMatchObject({
      person_id: null,
      team_id: null,
    })
  })
})

describe("resolveAttribution: issue #34 precedence (AI Gateway keys owned by their creator)", () => {
  const GW = "prov-aigw"
  // A team-attributed gateway key auto-owned by its creator (Alice, Platform), scoped to a Data project.
  const data = orgData()
  data.projects!.push({ id: "pr-gw", provider_id: GW, external_project_id: "prj_gw", name: "Banana", team_id: T.data })
  data.apiKeys.push({ id: "gk-team", provider_id: GW, external_key_id: "gk_team", owner_person_id: PE.alice, team_id: null, org_project_id: "pr-gw", assignment_source: "auto" })
  data.apiKeys.push({ id: "gk-none", provider_id: GW, external_key_id: "gk_none", owner_person_id: null, team_id: null, org_project_id: "pr-gw", assignment_source: "auto" })
  const idx = buildOrgIndex(data)
  const r = (attribution: Record<string, unknown>) => resolveAttribution({ provider_id: GW, metadata: { attribution } }, idx)

  it("1: a user_actor row on a gateway key owned by its creator resolves to the actor (and the actor's team)", () => {
    expect(r({ api_key_id: "gk_team", project_id: "prj_gw", person_email: "bob@liatrio.com", granularity: "person" })).toMatchObject({
      person_id: PE.bob,
      team_id: T.field,
      org_api_key_id: "gk-team",
      project_id: "prj_gw",
    })
  })

  it("3: a key-only row resolves to the creator owner, whose team beats the project's", () => {
    expect(r({ api_key_id: "gk_team", project_id: "prj_gw", granularity: "api_key" })).toMatchObject({ person_id: PE.alice, team_id: T.platform })
  })

  it("4: an unowned scoped key (unresolved creator) falls back to the project's team", () => {
    expect(r({ api_key_id: "gk_none", granularity: "api_key" })).toMatchObject({ person_id: null, team_id: T.data, project_id: "prj_gw" })
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

describe("resolveAttribution: AI Gateway key projects (migration 015)", () => {
  const GW = "prov-aigw"
  const WEB = "pr-web"
  const NT = "pr-nt"
  const idx = buildOrgIndex({
    ...orgData(),
    projects: [
      ...orgData().projects!,
      { id: WEB, provider_id: GW, external_project_id: "prj_web", name: "Website", team_id: T.platform },
      { id: NT, provider_id: GW, external_project_id: "prj_nt", name: "No team", team_id: null },
    ],
    apiKeys: [
      ...orgData().apiKeys,
      { id: "gk-user", provider_id: GW, external_key_id: "gk_user", owner_person_id: PE.carol, team_id: null, org_project_id: null },
      { id: "gk-user-team", provider_id: GW, external_key_id: "gk_user_team", owner_person_id: PE.bob, team_id: null },
      { id: "gk-proj", provider_id: GW, external_key_id: "gk_proj", owner_person_id: null, team_id: null, org_project_id: WEB },
      { id: "gk-person-proj", provider_id: GW, external_key_id: "gk_person_proj", owner_person_id: PE.dave, team_id: null, org_project_id: WEB },
      { id: "gk-key-team", provider_id: GW, external_key_id: "gk_key_team", owner_person_id: PE.dave, team_id: T.field, org_project_id: WEB },
      { id: "gk-xprov", provider_id: GW, external_key_id: "gk_xprov", owner_person_id: null, team_id: null, org_project_id: PR.sales },
    ],
  })
  const r = (attribution: Record<string, unknown>) =>
    resolveAttribution({ provider_id: GW, metadata: { attribution: { granularity: "api_key", ...attribution } } }, idx)

  // Same cases as scripts/migration-tests/assertions_015.sql.
  it("user-attributed key -> owner; owner without a team -> team Unassigned", () => {
    expect(r({ api_key_id: "gk_user" })).toMatchObject({ person_id: PE.carol, team_id: null, project_id: null })
  })
  it("user-attributed key -> owner -> owner's team", () => {
    expect(r({ api_key_id: "gk_user_team" })).toMatchObject({ person_id: PE.bob, team_id: T.field, department_id: D.sales })
  })
  it("project-scoped key -> project -> project's team", () => {
    expect(r({ api_key_id: "gk_proj", project_id: "prj_web" })).toMatchObject({
      person_id: null,
      org_api_key_id: "gk-proj",
      project_id: "prj_web",
      team_id: T.platform,
      department_id: D.eng,
      granularity: "api_key",
    })
  })
  it("key org_project_id applies when the row has no project_id", () => {
    expect(r({ api_key_id: "gk_proj" })).toMatchObject({ project_id: "prj_web", team_id: T.platform })
  })
  it("the row's project_id beats the key's project", () => {
    expect(r({ api_key_id: "gk_proj", project_id: "prj_nt" })).toMatchObject({ project_id: "prj_nt", team_id: null })
  })
  it("person team beats project team; key team beats both", () => {
    expect(r({ api_key_id: "gk_person_proj" })).toMatchObject({ person_id: PE.dave, team_id: T.data, project_id: "prj_web" })
    expect(r({ api_key_id: "gk_key_team" })).toMatchObject({ person_id: PE.dave, team_id: T.field, project_id: "prj_web" })
  })
  it("a key project from another provider is ignored", () => {
    expect(r({ api_key_id: "gk_xprov" })).toMatchObject({ project_id: null, team_id: null })
  })
  it("remainder rows stay org-level Unassigned", () => {
    expect(resolveAttribution({ provider_id: GW, metadata: { remainder: true, attribution: { granularity: "org" } } }, idx)).toMatchObject({
      ...UNASSIGNED,
      project_id: null,
      granularity: "org",
    })
  })
})
