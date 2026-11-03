import { canAssignToCreator, GATEWAY_PROVIDER } from "./key-status"

describe("canAssignToCreator (issues #32, #34)", () => {
  const key = (extra: Record<string, unknown> = {}) => ({
    owner_person_id: null as string | null,
    spend_attribution: "team" as string | null,
    external_created_by_email: "bob@liatrio.com" as string | null,
    ...extra,
  })

  test("shows for an unowned gateway key with a creator email, in every spend attribution", () => {
    for (const spend of ["team", null, "user"]) expect(canAssignToCreator(key({ spend_attribution: spend }), GATEWAY_PROVIDER)).toBe(true)
  })

  test("shows for a key owned by someone other than the creator", () => {
    expect(canAssignToCreator(key({ owner_person_id: "p-alice" }), GATEWAY_PROVIDER, "alice@liatrio.com")).toBe(true)
  })

  test("hidden when the owner is already the creator (emails compared case-insensitively)", () => {
    expect(canAssignToCreator(key({ owner_person_id: "p-bob" }), GATEWAY_PROVIDER, "Bob@Liatrio.com")).toBe(false)
    expect(canAssignToCreator(key({ owner_person_id: "p-bob", spend_attribution: "user" }), GATEWAY_PROVIDER, "bob@liatrio.com")).toBe(false)
  })

  test("hidden with no creator email, or for other providers", () => {
    expect(canAssignToCreator(key({ external_created_by_email: null }), GATEWAY_PROVIDER)).toBe(false)
    expect(canAssignToCreator(key({ external_created_by_email: "  " }), GATEWAY_PROVIDER)).toBe(false)
    expect(canAssignToCreator(key(), "anthropic")).toBe(false)
  })
})
