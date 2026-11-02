/**
 * Per-provider attribution coverage, from docs/attribution.md's "Provider
 * granularity" table. The dashboard shows these next to breakdown rows so a
 * provider that can't attribute at a level isn't read as $0 spend.
 *
 * "via_key" means the provider has no person on cost rows, but spend reaches
 * a person through the owner of a registered API key (org_api_keys).
 */

export type CoverageLevel = "yes" | "via_key" | "no"

export interface ProviderCoverage {
  person: CoverageLevel
  api_key: CoverageLevel
  /** Short note shown in tooltips and the coverage legend. */
  note: string
}

/** Keyed by providers.name (slug). */
export const PROVIDER_COVERAGE: Record<string, ProviderCoverage> = {
  anthropic: {
    person: "yes",
    api_key: "yes",
    note: "per person and API key (workspace only on the legacy cost report fallback)",
  },
  "claude-ai": { person: "yes", api_key: "no", note: "per person (actor email)" },
  openai: { person: "via_key", api_key: "yes", note: "per API key and project; people only via key owner" },
  cursor: { person: "yes", api_key: "no", note: "per member" },
  "vercel-ai-gateway": { person: "via_key", api_key: "yes", note: "per API key; the rest is org-level" },
  vercel: { person: "no", api_key: "no", note: "per project only" },
  windsurf: { person: "no", api_key: "no", note: "org-level only (flat seat cost)" },
  apify: { person: "no", api_key: "no", note: "org-level only" },
  chatgpt: { person: "no", api_key: "no", note: "org-level only (manual entry)" },
}

const ORG_ONLY: ProviderCoverage = { person: "no", api_key: "no", note: "org-level only" }

export function coverageFor(slug: string): ProviderCoverage {
  return PROVIDER_COVERAGE[slug] ?? ORG_ONLY
}

/**
 * Can this provider's spend land on an entity at this level? Teams and
 * departments are reachable through a person or a key.
 */
export function canAttribute(slug: string, level: "department" | "team" | "person" | "api_key"): boolean {
  const c = coverageFor(slug)
  if (level === "api_key") return c.api_key !== "no"
  if (level === "person") return c.person !== "no"
  return c.person !== "no" || c.api_key !== "no"
}

/** "Windsurf: org-level only" */
export function coverageLabel(displayName: string, slug: string): string {
  return `${displayName}: ${coverageFor(slug).note}`
}
