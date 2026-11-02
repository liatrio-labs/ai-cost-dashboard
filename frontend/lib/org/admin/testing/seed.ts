/**
 * Seed data for the admin org route tests: the shared org fixture
 * (lib/org/test-fixtures.ts) plus cost_records covering the import and
 * Unassigned cases. Test-only.
 */

import { orgData, P } from "../../test-fixtures"
import { FakeSupabase } from "./fake-supabase"

export const MONTH = "2026-11"

type Rec = { provider_id: string; timestamp: string; cost_usd: number; metadata: Record<string, unknown> | null }

let n = 0
const rec = (provider_id: string, day: string, cost_usd: number, attribution?: Record<string, unknown>): Rec & { id: string } => ({
  id: `cr-${String(++n).padStart(3, "0")}`,
  provider_id,
  timestamp: `${day}T12:00:00.000Z`,
  cost_usd,
  metadata: attribution ? { attribution } : {},
})

/**
 * November 2026 spend (org total 54.25):
 *   assigned:   alice 1 (Platform), key_team 20 (Data), proj_2 0.75 (Field)
 *   unassigned: person carol 0.5 (no team), new.person 10 + 5,
 *               api_key key_bare 3 (registered, no team; beats its project),
 *               api_key key_unknown 2 (not registered),
 *               project proj_9 4, other: legacy 7 + workspace-only 1
 * Plus one October row (carol 100) that the November queue must ignore.
 */
export function costRecords() {
  n = 0
  return [
    rec(P.anthropic, "2026-11-01", 1, { person_email: "alice@liatrio.com", granularity: "person" }),
    rec(P.openai, "2026-11-01", 20, { api_key_id: "key_team", granularity: "api_key" }),
    rec(P.openai, "2026-11-02", 0.75, { project_id: "proj_2", granularity: "project" }),
    rec(P.anthropic, "2026-11-02", 0.5, { person_email: "carol@liatrio.com", granularity: "person" }),
    rec(P.anthropic, "2026-11-03", 10, { person_email: "New.Person@liatrio.com", person_name: "New Person", granularity: "person" }),
    rec(P.cursor, "2026-11-04", 5, { person_email: "new.person@liatrio.com", granularity: "person" }),
    rec(P.openai, "2026-11-05", 3, { api_key_id: "key_bare", project_id: "proj_1", granularity: "project" }),
    rec(P.openai, "2026-11-05", 2, { api_key_id: "key_unknown", api_key_name: "CI key", granularity: "api_key" }),
    rec(P.openai, "2026-11-06", 4, { project_id: "proj_9", project_name: "Experiments", granularity: "project" }),
    rec(P.openai, "2026-11-07", 7),
    rec(P.anthropic, "2026-11-07", 1, { workspace_id: "wrk_1", granularity: "workspace" }),
    rec(P.anthropic, "2026-10-15", 100, { person_email: "carol@liatrio.com", granularity: "person" }),
    // Import-only cases: known through identities, so not candidates.
    rec(P.cursor, "2026-10-20", 1, { person_email: "dave.alias@liatrio.com", granularity: "person" }),
    rec(P.anthropic, "2026-10-21", 1, { person_email: "bobby@other.com", person_external_id: "user_bob", granularity: "person" }),
    rec(P.anthropic, "2026-10-22", 2, { person_email: "zed@liatrio.com", granularity: "person" }),
  ]
}

export function seedDb(): FakeSupabase {
  const org = orgData()
  return new FakeSupabase({
    providers: [
      { id: P.anthropic, name: "anthropic", display_name: "Anthropic" },
      { id: P.openai, name: "openai", display_name: "OpenAI" },
      { id: P.cursor, name: "cursor", display_name: "Cursor" },
    ],
    departments: org.departments,
    teams: org.teams,
    people: org.people.map((p) => ({ active: true, ...p })),
    person_identities: org.identities.map((i, idx) => ({ id: `ident-${idx + 1}`, ...i })),
    org_api_keys: org.apiKeys,
    org_projects: org.projects ?? [],
    cost_records: costRecords(),
  })
}
