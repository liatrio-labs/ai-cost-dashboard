import "@testing-library/jest-dom"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { listKeys, type ObservedRecord } from "@/lib/org/admin/observed"
import type { OrgApiKey } from "@/lib/org/types"
import { KeysByProjectCard } from "./keys-by-project"
import type { Org } from "./shared"

const OA = "prov-openai"
const AN = "prov-anthropic"
const GW = "prov-aigw"

const org: Org = {
  departments: [],
  teams: [{ id: "team-web", name: "Web", department_id: null }],
  people: [{ id: "p-alice", email: "alice@liatrio.com", display_name: "Alice", team_id: null }],
  identities: [],
  apiKeys: [],
  projects: [
    { id: "op-data", provider_id: OA, external_project_id: "proj_data", name: "Data", team_id: null },
    { id: "op-site", provider_id: GW, external_project_id: "prj_site", name: "Marketing site", team_id: null },
  ],
  providers: [
    { id: OA, name: "openai", display_name: "OpenAI API" },
    { id: AN, name: "anthropic", display_name: "Anthropic API" },
    { id: GW, name: "vercel-ai-gateway", display_name: "Vercel AI Gateway" },
  ],
} as unknown as Org

const records: ObservedRecord[] = [
  { provider_id: OA, timestamp: "2026-11-01T00:00:00Z", cost_usd: 40, attribution: { api_key_id: "oa_a", api_key_name: "pipeline", project_id: "proj_data", granularity: "api_key" } },
  { provider_id: AN, timestamp: "2026-11-02T00:00:00Z", cost_usd: 30, attribution: { api_key_id: "an_a", workspace_id: "wrk_r", granularity: "api_key" } },
]
const registered: OrgApiKey[] = [
  { id: "k-idle", provider_id: GW, external_key_id: "gw_idle", name: "idle key", owner_person_id: null, team_id: null, org_project_id: "op-site", assignment_source: "auto", external_created_by_email: "bob@liatrio.com" },
  { id: "k-none", provider_id: GW, external_key_id: "gw_none", name: "shared key", owner_person_id: null, team_id: null },
]

describe("KeysByProjectCard (issue #28)", () => {
  it("groups keys by provider and project/workspace, lists $0 keys, and assigns inline", async () => {
    const mutate = jest.fn(async () => true)
    render(<KeysByProjectCard org={org} mutate={mutate} keys={listKeys(records, registered)} projects={[]} />)

    const openai = screen.getByRole("region", { name: "OpenAI API" })
    expect(within(openai).getByRole("group", { name: "Project: Data" })).toHaveTextContent("pipeline")

    const anthropic = screen.getByRole("region", { name: "Anthropic API" })
    expect(within(anthropic).getByRole("group", { name: "Workspace: wrk_r" })).toHaveTextContent("an_a")

    const gateway = screen.getByRole("region", { name: "Vercel AI Gateway" })
    const site = within(gateway).getByRole("group", { name: "Vercel project: Marketing site" })
    expect(site).toHaveTextContent("idle key")
    expect(site).toHaveTextContent("$0.00")
    expect(site).toHaveTextContent("created by bob@liatrio.com")
    expect(site).toHaveTextContent("last seen never")
    const none = within(gateway).getByRole("group", { name: "Vercel project: No project" })
    expect(none).toHaveTextContent("shared key")

    await userEvent.selectOptions(within(none).getByLabelText("Owner of gw_none"), "p-alice")
    expect(mutate).toHaveBeenCalledWith(
      "/keys",
      "POST",
      { provider_id: GW, external_key_id: "gw_none", name: "shared key", owner_person_id: "p-alice" },
      "Key updated"
    )
    await userEvent.selectOptions(within(none).getByLabelText("Project for gw_none"), "op-site")
    expect(mutate).toHaveBeenLastCalledWith("/keys", "POST", expect.objectContaining({ org_project_id: "op-site" }), "Key updated")
    await userEvent.selectOptions(within(none).getByLabelText("Team for gw_none"), "team-web")
    expect(mutate).toHaveBeenLastCalledWith("/keys", "POST", expect.objectContaining({ team_id: "team-web" }), "Key updated")
  })
})

describe("KeysByProjectCard (issue #32)", () => {
  const anOrg = {
    ...org,
    projects: [
      ...org.projects,
      { id: "an-r", provider_id: AN, external_project_id: "wrk_r", name: "Research", team_id: null },
      { id: "an-d", provider_id: AN, external_project_id: "default", name: "Default", team_id: null },
    ],
  } as unknown as Org
  const anKeys: OrgApiKey[] = [
    { id: "a1", provider_id: AN, external_key_id: "an_a", name: "alice key", owner_person_id: "p-alice", team_id: null, org_project_id: "an-r", assignment_source: "auto", external_created_by: "user_alice", external_created_by_email: "alice@liatrio.com", external_status: "active" },
    { id: "a2", provider_id: AN, external_key_id: "an_svc", name: "ci key", owner_person_id: null, team_id: null, org_project_id: "an-d", assignment_source: "auto", external_created_by: "service_account:sa_1", external_status: "archived", unresolved_reason: "service_account" },
    { id: "a3", provider_id: AN, external_key_id: "an_gone", name: "old key", owner_person_id: null, team_id: null, org_project_id: "an-r", assignment_source: "auto", external_created_by: "user_gone", external_status: "inactive", unresolved_reason: "deleted_user" },
  ]
  const gwKeys: OrgApiKey[] = [
    { id: "g1", provider_id: GW, external_key_id: "gw_team", name: "team key", owner_person_id: null, team_id: null, spend_attribution: "team", external_created_by_email: "bob@liatrio.com" },
    { id: "g2", provider_id: GW, external_key_id: "gw_unset", name: "unset key", owner_person_id: null, team_id: null, spend_attribution: null, external_created_by_email: "bob@liatrio.com" },
    { id: "g3", provider_id: GW, external_key_id: "gw_user", name: "user key", owner_person_id: null, team_id: null, spend_attribution: "user", external_created_by_email: "bob@liatrio.com" },
    { id: "g4", provider_id: GW, external_key_id: "gw_owned", name: "owned key", owner_person_id: "p-alice", team_id: null, spend_attribution: "team", external_created_by_email: "bob@liatrio.com", assignment_source: "manual" },
    { id: "g5", provider_id: GW, external_key_id: "gw_nocreator", name: "no creator", owner_person_id: null, team_id: null, spend_attribution: "team" },
  ]

  it("lists Anthropic keys under workspace projects with status, creator and owner; unresolved ones with their reason", () => {
    render(<KeysByProjectCard org={anOrg} mutate={jest.fn(async () => true)} keys={listKeys(records, anKeys)} projects={[]} />)
    const anthropic = screen.getByRole("region", { name: "Anthropic API" })
    const research = within(anthropic).getByRole("group", { name: "Workspace: Research" })
    expect(research).toHaveTextContent("alice key")
    expect(research).toHaveTextContent("active")
    expect(research).toHaveTextContent("owner Alice")
    expect(research).toHaveTextContent("created by alice@liatrio.com")
    expect(research).toHaveTextContent("$30.00")
    const def = within(anthropic).getByRole("group", { name: "Workspace: Default" })
    expect(def).toHaveTextContent("ci key")
    expect(def).toHaveTextContent("archived")
    expect(def).toHaveTextContent("owner none (created by a service account)")
    expect(def).toHaveTextContent("created by service_account:sa_1")

    const unassigned = within(anthropic).getByRole("group", { name: "Unassigned keys" })
    const items = within(unassigned).getAllByTestId("unassigned-key").map((li) => li.textContent?.replace(/\s+/g, " "))
    expect(items.sort()).toEqual(["ci key: created by a service account · $0.00", "old key: creator is no longer in the organization · $0.00"])
    expect(within(anthropic).queryByRole("button", { name: /to creator/ })).toBeNull()
  })

  it("issue #34: shows Assign to creator for any gateway key with a creator email whose owner isn't the creator", async () => {
    const mutate = jest.fn(async () => true)
    const keys: OrgApiKey[] = [
      ...gwKeys,
      // Owned by its creator (Alice): no button, whatever the spend attribution.
      { id: "g6", provider_id: GW, external_key_id: "gw_mine", name: "mine", owner_person_id: "p-alice", team_id: null, spend_attribution: "team", external_created_by_email: "Alice@liatrio.com", assignment_source: "auto" },
      { id: "g7", provider_id: GW, external_key_id: "gw_mine_user", name: "mine too", owner_person_id: "p-alice", team_id: null, spend_attribution: "user", external_created_by_email: "alice@liatrio.com", assignment_source: "auto" },
    ]
    render(<KeysByProjectCard org={anOrg} mutate={mutate} keys={listKeys([], keys)} projects={[]} />)
    const gateway = screen.getByRole("region", { name: "Vercel AI Gateway" })
    const buttons = within(gateway).getAllByRole("button", { name: /to creator/ }).map((b) => b.getAttribute("aria-label"))
    // Unowned keys (team, unset, user) and gw_owned (owned by Alice, created by Bob); not gw_nocreator, gw_mine or gw_mine_user.
    expect(buttons.sort()).toEqual(["Assign gw_owned to creator", "Assign gw_team to creator", "Assign gw_unset to creator", "Assign gw_user to creator"])

    await userEvent.click(within(gateway).getByRole("button", { name: "Assign gw_team to creator" }))
    expect(mutate).toHaveBeenCalledWith("/keys/assign-creator", "POST", { provider_id: GW, external_key_id: "gw_team" }, "Assigned to bob@liatrio.com")
  })

  it("issue #34: lists gateway keys with no owner under Unassigned keys with the same reason labels", () => {
    const keys: OrgApiKey[] = [
      { id: "u1", provider_id: GW, external_key_id: "gw_nc", name: "no creator key", owner_person_id: null, team_id: null, spend_attribution: "team", unresolved_reason: "no_creator" },
      { id: "u2", provider_id: GW, external_key_id: "gw_um", name: "unmatched key", owner_person_id: null, team_id: null, spend_attribution: null, external_created_by: "uid_x", unresolved_reason: "unmatched_creator" },
      { id: "u3", provider_id: GW, external_key_id: "gw_ok", name: "owned key", owner_person_id: "p-alice", team_id: null, spend_attribution: "team", external_created_by_email: "alice@liatrio.com", assignment_source: "auto" },
    ]
    render(<KeysByProjectCard org={anOrg} mutate={jest.fn(async () => true)} keys={listKeys([], keys)} projects={[]} />)
    const gateway = screen.getByRole("region", { name: "Vercel AI Gateway" })
    const unassigned = within(gateway).getByRole("group", { name: "Unassigned keys" })
    const items = within(unassigned).getAllByTestId("unassigned-key").map((li) => li.textContent?.replace(/\s+/g, " "))
    expect(items.sort()).toEqual(["no creator key: no creator recorded · $0.00", "unmatched key: creator has no email to match · $0.00"])
  })
})
