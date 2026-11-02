/**
 * Helpers for building `metadata.attribution` (see the Attribution contract in
 * ./types and docs/attribution.md).
 */

import type { Attribution, AttributionGranularity } from "./types"

type Dimensions = Omit<Attribution, "granularity">

/** Lower-case + trim an email; empty / non-string -> null. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null
  const v = value.trim().toLowerCase()
  return v ? v : null
}

/** Trimmed non-empty string, else null. */
export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const v = String(value).trim()
  return v ? v : null
}

/**
 * The finest dimension present: person > api_key > project > workspace > org.
 */
export function granularityOf(d: Dimensions): AttributionGranularity {
  if (d.person_email || d.person_external_id) return "person"
  if (d.api_key_id) return "api_key"
  if (d.project_id) return "project"
  if (d.workspace_id) return "workspace"
  return "org"
}

/**
 * Build an Attribution from whatever dimensions the provider returned. Null /
 * undefined fields are dropped so stored metadata stays compact; granularity is
 * derived unless given explicitly.
 */
export function buildAttribution(
  d: Dimensions,
  granularity?: AttributionGranularity
): Attribution {
  const out: Attribution = { granularity: granularity ?? granularityOf(d) }
  for (const [k, v] of Object.entries(d) as [keyof Dimensions, string | null | undefined][]) {
    if (v !== null && v !== undefined && v !== "") out[k] = v
  }
  return out
}

/** Org-level (Unassigned) attribution. */
export function orgAttribution(): Attribution {
  return { granularity: "org" }
}
