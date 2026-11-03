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
