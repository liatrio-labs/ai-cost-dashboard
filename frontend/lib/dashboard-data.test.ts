import { fetchOrgData, type SupabaseLike } from "./dashboard-data"

/** Minimal SupabaseLike: records each select and answers per table. */
function fake(answer: (table: string, columns: string) => { data: unknown[] | null; error: unknown }) {
  const selects: string[] = []
  const client: SupabaseLike = {
    from(table: string) {
      return {
        select(columns: string) {
          selects.push(`${table}: ${columns}`)
          const result = answer(table, columns)
          const q = {
            order: () => q,
            range: () => q,
            eq: () => q,
            is: () => q,
            then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
          }
          return q as never
        },
      }
    },
  }
  return { client, selects }
}

describe("fetchOrgData (issue #28)", () => {
  it("selects the key's assigned project so $0 keys group under it", async () => {
    const { client, selects } = fake((table) => ({
      data: table === "org_api_keys" ? [{ id: "k1", provider_id: "gw", external_key_id: "x", org_project_id: "op-1" }] : [],
      error: null,
    }))
    const org = await fetchOrgData(client)
    expect(selects.find((s) => s.startsWith("org_api_keys"))).toMatch(/org_project_id/)
    expect(org.apiKeys[0].org_project_id).toBe("op-1")
  })

  it("falls back to the pre-015 columns when org_project_id doesn't exist", async () => {
    const { client, selects } = fake((table, columns) =>
      table === "org_api_keys" && columns.includes("org_project_id")
        ? { data: null, error: { code: "42703", message: "column org_api_keys.org_project_id does not exist" } }
        : { data: table === "org_api_keys" ? [{ id: "k1" }] : [], error: null }
    )
    const org = await fetchOrgData(client)
    expect(selects.filter((s) => s.startsWith("org_api_keys"))).toHaveLength(2)
    expect(org.apiKeys).toEqual([{ id: "k1" }])
  })

  it("other key errors still throw", async () => {
    const { client } = fake((table) =>
      table === "org_api_keys" ? { data: null, error: { code: "42501", message: "permission denied" } } : { data: [], error: null }
    )
    await expect(fetchOrgData(client)).rejects.toMatchObject({ code: "42501" })
  })
})
