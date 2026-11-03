/**
 * Per-provider attribution coverage, from docs/attribution.md's
 * "Provider granularity" table. The dashboard shows these next to org
 * breakdowns so a provider that cannot attribute spend to a person or key
 * isn't read as $0 for that person or key.
 *
 * Keyed by providers.name (the slug). Update with docs/attribution.md.
 *
 * AI Gateway (issue #24): a key's spend reaches a person when its
 * spendAttribution is "user" (the creator, mapped by the key sync) or an admin
 * sets an owner, and a project when the key is project-scoped. OIDC, PAT and
 * app-token spend has no key and stays org-level (the remainder row) unless
 * apps send a project tag such as `ai-reporting-tags: project:<name>`; tag
 * attribution is not collected yet.
 */

export type CoverageSupport = "yes" | "via_key_owner" | "no"

export interface ProviderCoverage {
  /** Can spend land on a person? via_key_owner: only through an API key's owner. */
  person: CoverageSupport
  /** Can spend land on an API key? */
  api_key: boolean
  /** Short note shown in the UI, e.g. "org-level only". */
  note: string
}

export const PROVIDER_COVERAGE: Record<string, ProviderCoverage> = {
  anthropic: { person: "yes", api_key: true, note: "per person and API key (legacy fallback: workspace only)" },
  "claude-ai": { person: "yes", api_key: false, note: "per person; no API keys" },
  openai: { person: "via_key_owner", api_key: true, note: "per API key and project; people only via key owner" },
  cursor: { person: "yes", api_key: false, note: "per person; no API keys" },
  "vercel-ai-gateway": {
    person: "via_key_owner",
    api_key: true,
    note: "per API key; people via key creator (user spend attribution) or owner; projects via project-scoped keys; OIDC/PAT/app-token spend stays org-level",
  },
  vercel: { person: "no", api_key: false, note: "per project only" },
  windsurf: { person: "no", api_key: false, note: "org-level only (flat seat cost)" },
  apify: { person: "no", api_key: false, note: "org-level only" },
  chatgpt: { person: "no", api_key: false, note: "org-level only (manual entry)" },
  "claude-desktop": { person: "no", api_key: false, note: "org-level only (manual entry)" },
}

const UNKNOWN: ProviderCoverage = { person: "no", api_key: false, note: "org-level only" }

export function coverageFor(providerSlug: string): ProviderCoverage {
  return PROVIDER_COVERAGE[providerSlug] ?? UNKNOWN
}

export type CoverageLevel = "department" | "team" | "person" | "api_key"

/**
 * Can this provider's spend reach an entity at `level`? Departments and teams
 * come from a person or a key, so either one is enough.
 */
export function canAttribute(providerSlug: string, level: CoverageLevel): boolean {
  const c = coverageFor(providerSlug)
  if (level === "api_key") return c.api_key
  if (level === "person") return c.person !== "no"
  return c.person !== "no" || c.api_key
}
