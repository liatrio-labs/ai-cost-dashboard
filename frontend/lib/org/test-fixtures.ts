/**
 * Shared Jest fixture: the same org as scripts/migration-tests/fixtures.sql,
 * so the TS and SQL implementations are checked against the same cases.
 */

import type { OrgData } from "./types"

export const P = { anthropic: "prov-anthropic", openai: "prov-openai", cursor: "prov-cursor" }
export const D = { eng: "dept-eng", sales: "dept-sales" }
export const T = { platform: "team-platform", data: "team-data", field: "team-field", orphan: "team-orphan" }
export const PE = { alice: "p-alice", bob: "p-bob", carol: "p-carol", dave: "p-dave", erin: "p-erin" }
export const K = { team: "k-team", owner: "k-owner", bare: "k-bare" }

export function orgData(): OrgData {
  return {
    departments: [
      { id: D.eng, name: "Engineering" },
      { id: D.sales, name: "Sales" },
    ],
    teams: [
      { id: T.platform, name: "Platform", department_id: D.eng },
      { id: T.data, name: "Data", department_id: D.eng },
      { id: T.field, name: "Field", department_id: D.sales },
      { id: T.orphan, name: "Orphan", department_id: null },
    ],
    people: [
      { id: PE.alice, email: "alice@liatrio.com", display_name: "Alice", team_id: T.platform },
      { id: PE.bob, email: "bob@liatrio.com", display_name: "Bob", team_id: T.field },
      { id: PE.carol, email: "carol@liatrio.com", display_name: null, team_id: null },
      { id: PE.dave, email: "dave@liatrio.com", display_name: "Dave", team_id: T.data },
      { id: PE.erin, email: "erin@liatrio.com", display_name: "Erin", team_id: T.orphan },
    ],
    identities: [
      { person_id: PE.bob, provider_id: P.anthropic, external_id: "user_bob" },
      { person_id: PE.dave, provider_id: P.cursor, external_id: "dave.alias@liatrio.com" },
    ],
    apiKeys: [
      { id: K.team, provider_id: P.openai, external_key_id: "key_team", name: "Data pipeline key", owner_person_id: PE.alice, team_id: T.data },
      { id: K.owner, provider_id: P.openai, external_key_id: "key_owner", name: null, owner_person_id: PE.bob, team_id: null },
      { id: K.bare, provider_id: P.openai, external_key_id: "key_bare", name: "Unowned key", owner_person_id: null, team_id: null },
    ],
  }
}
