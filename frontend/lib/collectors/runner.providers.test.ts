/**
 * Pins the set of automated collectors and their env wiring (issue #27: the
 * vercel hosting-usage, apify and windsurf collectors were removed). Adding or
 * removing a collector must update this list on purpose.
 */

jest.mock("@/lib/supabase/admin", () => ({
  createAdminClient: jest.fn(),
  touchProvidersCollected: jest.fn(),
}))

import { COLLECTORS, PROVIDER_ENV } from "./runner"

const REMAINING = ["anthropic", "claude-ai", "openai", "cursor", "vercel-ai-gateway"]

describe("runner provider registry", () => {
  it("COLLECTORS has exactly the remaining providers", () => {
    expect(Object.keys(COLLECTORS).sort()).toEqual([...REMAINING].sort())
  })

  it("PROVIDER_ENV has exactly the remaining providers", () => {
    expect(PROVIDER_ENV).toEqual({
      anthropic: { apiKey: "ANTHROPIC_ADMIN_KEY", orgId: "ANTHROPIC_ORG_ID" },
      "claude-ai": { apiKey: "CLAUDE_AI_ANALYTICS_KEY", orgId: "CLAUDE_AI_ORG_ID" },
      openai: { apiKey: "OPENAI_ADMIN_KEY", orgId: "OPENAI_ORG_ID" },
      cursor: { apiKey: "CURSOR_ADMIN_KEY", teamId: "CURSOR_TEAM_ID" },
      "vercel-ai-gateway": {
        apiKey: "AI_GATEWAY_API_KEY",
        teamId: "VERCEL_TEAM_ID",
        auxApiKey: "VERCEL_TOKEN",
      },
    })
  })

  it("every collector has env config and vice versa", () => {
    expect(Object.keys(PROVIDER_ENV).sort()).toEqual(Object.keys(COLLECTORS).sort())
  })

  it.each(["vercel", "apify", "windsurf"])("%s is no longer registered", (p) => {
    expect(COLLECTORS[p]).toBeUndefined()
    expect(PROVIDER_ENV[p]).toBeUndefined()
  })
})
