/**
 * Shared Jest fixture for the admin org helpers and routes (#7): November
 * 2026 cost_records against the org in ./test-fixtures.
 *
 * Totals: 42.5 overall, 16 assigned to a team, 26.5 Unassigned.
 */

import type { ObservedRecord } from "./observed"
import { P } from "./test-fixtures"

const attr = (a: Record<string, unknown>) => ({ attribution: { granularity: "person", ...a } })

/** November 2026 records against the shared org fixture. */
export function novemberRecords(): ObservedRecord[] {
  return [
    // assigned: alice -> Platform
    { provider_id: P.cursor, timestamp: "2026-11-01T00:00:00Z", cost_usd: 10, metadata: attr({ person_email: "alice@liatrio.com" }) },
    // carol exists with no team
    { provider_id: P.cursor, timestamp: "2026-11-01T00:00:00Z", cost_usd: 5, metadata: attr({ person_email: "Carol@Liatrio.com " }) },
    { provider_id: P.anthropic, timestamp: "2026-11-02T00:00:00Z", cost_usd: "2.5", metadata: attr({ person_email: "carol@liatrio.com" }) },
    // a new email with no person
    { provider_id: P.anthropic, timestamp: "2026-11-02T00:00:00Z", cost_usd: 4, metadata: attr({ person_email: "zed@liatrio.com", person_name: "Zed" }) },
    // registered key with no owner and no team
    { provider_id: P.openai, timestamp: "2026-11-02T00:00:00Z", cost_usd: 3, metadata: attr({ api_key_id: "key_bare", granularity: "api_key" }) },
    // unregistered key
    { provider_id: P.openai, timestamp: "2026-11-03T00:00:00Z", cost_usd: 2, metadata: attr({ api_key_id: "key_new", api_key_name: "CI key", project_id: "proj_1", granularity: "api_key" }) },
    // assigned: key_team -> Data
    { provider_id: P.openai, timestamp: "2026-11-03T00:00:00Z", cost_usd: 6, metadata: attr({ api_key_id: "key_team", granularity: "api_key" }) },
    // project only
    { provider_id: P.openai, timestamp: "2026-11-03T00:00:00Z", cost_usd: 1.5, metadata: attr({ project_id: "proj_1", project_name: "Research", granularity: "project" }) },
    // no attribution at all
    { provider_id: P.anthropic, timestamp: "2026-11-04T00:00:00Z", cost_usd: 8, metadata: {} },
    // external id with no identity mapping
    { provider_id: P.anthropic, timestamp: "2026-11-04T00:00:00Z", cost_usd: 0.5, metadata: attr({ person_external_id: "user_unknown" }) },
  ]
}
