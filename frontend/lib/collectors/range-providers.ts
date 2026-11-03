/**
 * Explicit date-range constants (issue #20, #28), kept free of collector
 * imports so client components (the /admin pull card) can use them.
 */

/** Longest accepted range, in days, end inclusive. Matches the analytics API span limit. */
export const MAX_RANGE_DAYS = 31

/** Providers whose collectors honour CollectOptions.range. */
export const RANGE_PROVIDERS = ["anthropic", "claude-ai", "openai", "vercel-ai-gateway"] as const

export function supportsRange(provider: string): boolean {
  return (RANGE_PROVIDERS as readonly string[]).includes(provider)
}
