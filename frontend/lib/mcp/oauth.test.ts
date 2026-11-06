/**
 * @jest-environment node
 *
 * Issue #94: unit tests for the MCP OAuth building blocks.
 */

import { isLiatrioEmail, liatrioEmail, liatrioGoogleEmail } from "@/lib/mcp/liatrio-email"
import { isOAuthConfigured, open, seal, verifyPkceS256 } from "@/lib/mcp/oauth-crypto"
import { isAllowedRedirectUri, lookupClient, redirectUriMatches, registerClient } from "@/lib/mcp/oauth-clients"
import { createHash } from "node:crypto"

const SECRET = "unit-test-secret-0123456789-abcdefghijklmnop"

beforeEach(() => {
  process.env.MCP_OAUTH_SECRET = SECRET
})

describe("liatrio-only email check", () => {
  it.each(["robert@liatrio.com", " Robert@Liatrio.com ", "first.last+mcp@liatrio.com"])("accepts %s", (e) => {
    expect(isLiatrioEmail(e)).toBe(true)
  })
  it("normalizes", () => expect(liatrioEmail(" Robert@Liatrio.COM ")).toBe("robert@liatrio.com"))
  it.each([
    "robert@gmail.com",
    "robert@liatrio.co",
    "robert@liatrio.com.evil.example",
    "robert@eng.liatrio.com",
    "robert@notliatrio.com",
    "robert@liatrio.com@gmail.com",
    "Robert <robert@liatrio.com>",
    "@liatrio.com",
    ".robert@liatrio.com",
    "rob..ert@liatrio.com",
    "",
    null,
    42,
  ])("rejects %p", (e) => {
    expect(isLiatrioEmail(e)).toBe(false)
  })

  it("requires a Google identity with the same verified liatrio email", () => {
    const g = (email: string, extra: Record<string, unknown> = {}) => ({ provider: "google", identity_data: { email, ...extra } })
    expect(liatrioGoogleEmail({ email: "a@liatrio.com", identities: [g("a@liatrio.com")] })).toBe("a@liatrio.com")
    expect(liatrioGoogleEmail({ email: "a@liatrio.com", identities: [{ provider: "email", identity_data: { email: "a@liatrio.com" } }] })).toBeNull()
    expect(liatrioGoogleEmail({ email: "a@liatrio.com", identities: [g("a@gmail.com")] })).toBeNull()
    expect(liatrioGoogleEmail({ email: "a@liatrio.com", identities: [g("a@liatrio.com", { email_verified: false })] })).toBeNull()
    expect(liatrioGoogleEmail({ email: "a@gmail.com", identities: [g("a@gmail.com")] })).toBeNull()
    expect(liatrioGoogleEmail(null)).toBeNull()
  })
})

describe("sealed OAuth artifacts", () => {
  const exp = () => Math.floor(Date.now() / 1000) + 60

  it("round-trips and binds the type", () => {
    const t = seal("access", { a: 1, exp: exp() })
    expect(open("access", t)).toMatchObject({ a: 1, typ: "access" })
    expect(open("refresh", t)).toBeNull()
    expect(open("code", t)).toBeNull()
  })

  it("fails closed on tampering, expiry, a rotated secret or no secret", () => {
    const t = seal("code", { exp: exp() })
    const flipped = t.slice(0, -2) + (t.endsWith("A") ? "B" : "A") + t.slice(-1)
    expect(open("code", flipped)).toBeNull()
    expect(open("code", seal("code", { exp: 1 }))).toBeNull()
    expect(open("code", seal("code", {}))).toBeNull() // no exp
    process.env.MCP_OAUTH_SECRET = SECRET + "-rotated"
    expect(open("code", t)).toBeNull()
    delete process.env.MCP_OAUTH_SECRET
    expect(isOAuthConfigured()).toBe(false)
    expect(open("code", t)).toBeNull()
    expect(() => seal("code", {})).toThrow(/MCP_OAUTH_SECRET/)
    process.env.MCP_OAUTH_SECRET = "too-short"
    expect(isOAuthConfigured()).toBe(false)
  })

  it("verifies PKCE S256", () => {
    const v = "v".repeat(43)
    const c = createHash("sha256").update(v).digest("base64url")
    expect(verifyPkceS256(v, c)).toBe(true)
    expect(verifyPkceS256("w".repeat(43), c)).toBe(false)
    expect(verifyPkceS256("short", c)).toBe(false)
  })
})

describe("client registration", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "http://localhost:6274/oauth/callback",
    "http://127.0.0.1:33418/callback",
  ])("allows %s", (u) => expect(isAllowedRedirectUri(u)).toBe(true))

  it.each(["http://example.com/cb", "javascript:alert(1)", "data:text/html,x", "https://x.example/cb#frag", "https://user:pw@x.example/cb", "not a url"])(
    "refuses %s",
    (u) => expect(isAllowedRedirectUri(u)).toBe(false)
  )

  it("issues a sealed client id that can't be edited, and matches loopback ports", () => {
    const c = registerClient({ client_name: "Claude Code", redirect_uris: ["http://localhost:1234/callback"] })
    const found = lookupClient(c.client_id)!
    expect(found.redirect_uris).toEqual(["http://localhost:1234/callback"])
    expect(redirectUriMatches(found, "http://localhost:5555/callback")).toBe(true)
    expect(redirectUriMatches(found, "http://localhost:5555/other")).toBe(false)
    expect(redirectUriMatches(found, "https://localhost/callback")).toBe(false)
    expect(lookupClient("forged-client")).toBeNull()
    expect(() => registerClient({ redirect_uris: [] })).toThrow()
    expect(() => registerClient({ redirect_uris: ["https://ok.example/cb"], grant_types: ["client_credentials"] })).toThrow()
  })
})
