import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DuplicatesCard, describeMerge } from "./merge"
import type { Org } from "./shared"

const org = {
  departments: [],
  teams: [{ id: "t-data", name: "Data", department_id: null }],
  people: [],
  identities: [],
  apiKeys: [],
  projects: [],
  providers: [],
} as unknown as Org

const GROUP = {
  key: "p1,p2",
  reasons: [{ kind: "name", value: "dave" }],
  suggestedPrimaryId: "p1",
  members: [
    { id: "p1", email: "dave@liatrio.com", display_name: "Dave", team_id: "t-data", active: true, identities: 1, keys: 0 },
    { id: "p2", email: "dave@liatrio.io", display_name: "Dave", team_id: null, active: true, identities: 1, keys: 1 },
  ],
}
const PREVIEW = {
  primary: GROUP.members[0],
  secondary: GROUP.members[1],
  identities_moved: 1,
  keys_moved: 1,
  seat_rows_moved: 2,
  aliases_added: 3,
  team_adopted: false,
  display_name_adopted: false,
  result: { email: "dave@liatrio.com", display_name: "Dave", team_id: "t-data", active: true },
}

function mockFetch(migration021: boolean) {
  const calls: { url: string; body: unknown }[] = []
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data })
    if (url.endsWith("/duplicates")) return ok({ migration021, message: migration021 ? null : "Migration 021 not applied: merging is disabled.", groups: [GROUP] })
    if (body?.preview) return ok({ migration021, preview: PREVIEW })
    return ok({ migration021: true, result: { ...PREVIEW, already_merged: false, primary_id: "p1", secondary_id: "p2", secondary_email: "dave@liatrio.io" } })
  }) as unknown as typeof fetch
  return calls
}

describe("Possible duplicates card (issue #51)", () => {
  it("lists the group, previews the moved counts, then merges", async () => {
    const user = userEvent.setup()
    const calls = mockFetch(true)
    const onMerged = jest.fn(async () => undefined)
    window.confirm = jest.fn(() => true)
    render(<DuplicatesCard org={org} onMerged={onMerged} />)

    expect(await screen.findByText("Possible duplicates (1)")).toBeInTheDocument()
    expect(screen.getByText("same name “dave”")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "Keep dave@liatrio.com" })).toBeChecked()
    const mergeBtn = screen.getByRole("button", { name: /Merge into Dave/ })
    expect(mergeBtn).toBeDisabled() // preview first

    await user.click(screen.getByRole("button", { name: "Preview merge" }))
    expect(await screen.findByTestId("merge-preview-p2")).toHaveTextContent(
      "Moves 1 identity, 1 API key, 2 seat rows, 3 email aliases. Afterwards: Dave · dave@liatrio.com · Data."
    )
    expect(calls.at(-1)?.body).toEqual({ primary_id: "p1", secondary_id: "p2", preview: true })

    await user.click(screen.getByRole("button", { name: /Merge into Dave/ }))
    await waitFor(() => expect(onMerged).toHaveBeenCalled())
    expect(calls.at(-1)?.body).toEqual({ primary_id: "p1", secondary_id: "p2" })
    expect(onMerged.mock.calls[0]).toEqual(["Merged dave@liatrio.io into dave@liatrio.com. Moves 1 identity, 1 API key, 2 seat rows, 3 email aliases."])
  })

  it("without migration 021: shows the notice and keeps merge disabled after a preview", async () => {
    const user = userEvent.setup()
    mockFetch(false)
    render(<DuplicatesCard org={org} onMerged={jest.fn()} />)
    expect(await screen.findByRole("status")).toHaveTextContent("Migration 021 not applied")
    await user.click(screen.getByRole("button", { name: "Preview merge" }))
    await screen.findByTestId("merge-preview-p2")
    expect(screen.getByRole("button", { name: /Merge into Dave/ })).toBeDisabled()
  })

  it("switching the record to keep previews the other direction", async () => {
    const user = userEvent.setup()
    const calls = mockFetch(true)
    render(<DuplicatesCard org={org} onMerged={jest.fn()} />)
    await user.click(await screen.findByRole("radio", { name: "Keep dave@liatrio.io" }))
    await user.click(screen.getByRole("button", { name: "Preview merge" }))
    expect(calls.at(-1)?.body).toEqual({ primary_id: "p2", secondary_id: "p1", preview: true })
  })

  it("describeMerge mentions adopted team and name", () => {
    expect(describeMerge({ ...PREVIEW, team_adopted: true, display_name_adopted: true }, "Field")).toBe(
      "Moves 1 identity, 1 API key, 2 seat rows, 3 email aliases; adopts team Field and name"
    )
  })

  it("a network failure shows an error and re-enables the buttons (Bugbot review)", async () => {
    const user = userEvent.setup()
    mockFetch(true)
    const ok = global.fetch
    render(<DuplicatesCard org={org} onMerged={jest.fn()} />)
    await screen.findByText("Possible duplicates (1)")
    global.fetch = jest.fn(async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    await user.click(screen.getByRole("button", { name: "Preview merge" }))
    expect(await screen.findByText("Request failed: offline")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview merge" })).toBeEnabled()
    global.fetch = ok
    await user.click(screen.getByRole("button", { name: "Preview merge" }))
    expect(await screen.findByTestId("merge-preview-p2")).toBeInTheDocument()
  })
})

it("a failing merge (network) shows the error and re-enables Merge (Bugbot review)", async () => {
  const user = userEvent.setup()
  mockFetch(true)
  const ok = global.fetch
  window.confirm = jest.fn(() => true)
  render(<DuplicatesCard org={org} onMerged={jest.fn()} />)
  await user.click(await screen.findByRole("button", { name: "Preview merge" }))
  await screen.findByTestId("merge-preview-p2")
  global.fetch = jest.fn(async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch
  await user.click(screen.getByRole("button", { name: /Merge into Dave/ }))
  expect(await screen.findByText("Request failed: offline")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: /Merge into Dave/ })).toBeEnabled()
  global.fetch = ok
})
