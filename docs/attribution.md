# Cost attribution in collectors

Collectors write sub-org attribution to `cost_records.metadata.attribution`,
following the shared contract from epic #4 (defined in
`frontend/lib/collectors/types.ts` as `Attribution`):

```ts
interface Attribution {
  person_email?: string | null        // lower-cased
  person_external_id?: string | null  // provider's user / actor id
  person_name?: string | null
  api_key_id?: string | null          // provider's stable key id (never the secret)
  api_key_name?: string | null
  project_id?: string | null          // OpenAI project, Vercel project
  project_name?: string | null
  workspace_id?: string | null        // Anthropic workspace
  granularity: "person" | "api_key" | "project" | "workspace" | "org"
}
```

A collector sets only the fields the provider API actually returns, and leaves
out null fields. `granularity` is the finest dimension on the row, in the order
person > api_key > project > workspace > org. A row can carry coarser
dimensions too: for example, an OpenAI row with `granularity: "api_key"` still
has its `project_id`. Rows with no `attribution` (collected before #6) count as
`org` (Unassigned).

## Invariants

- **Totals reconcile.** For each provider and day, attributed rows plus `org`
  rows sum to the same org total the collector produced before. Each collector
  has a fixture test that checks this: `anthropic.test.ts`, `claude-ai.test.ts`,
  `openai.test.ts` and `vercel-ai-gateway.test.ts`.
- **Idempotent re-pulls.** The runner deletes every `api_automated` row for the
  provider, owner and bucket timestamps, then inserts the new set. The delete
  never filters on attribution, so re-pulling a day replaces all of that day's
  rows, including when the attribution changed (`runner.test.ts`).
- **`model_name` is never null**, as before.

## Provider granularity

| Provider | Person | API key | Project / workspace | Rows per day | Endpoints |
|---|---|---|---|---|---|
| Anthropic API | yes (`user_actor`) | yes | workspace | actor × api key × workspace × model | `GET /v1/organizations/analytics/cost` + `/analytics/usage` (beta `analytics-usage-cost-2026-08-24`), `group_by[]=actor,api_key_id,workspace_id,model`; fallback `cost_report` + `usage_report/messages` with `group_by[]=workspace_id` |
| Claude.ai Enterprise | yes (actor email) | n/a | n/a (`rbac_group_id` maps to claude.ai groups, not collected) | actor × model × product | same analytics endpoints, `group_by[]=actor,model,product`; fallback legacy `analytics/cost_report` + `usage_report` by model (org only) |
| OpenAI API | no on cost (see gaps); usage `user_id` kept as a hint | yes | project | line_item × project × api key | `GET /v1/organization/costs` `group_by=line_item,project_id,api_key_id` (retries without `api_key_id` on 400); `/usage/completions` `group_by=model,project_id,api_key_id,user_id`; names from `/organization/projects` and `/projects/{id}/api_keys` |
| Cursor | yes (member email) | n/a | n/a | member × model | `POST /teams/filtered-usage-events` (unchanged) |
| Vercel AI Gateway | no (would need apps to send `user`) | yes | n/a (tags not collected) | one per key with spend, plus an org remainder | `GET ai-gateway.vercel.sh/v1/report?group_by=day` once unfiltered and once per key with `api_key_id=<id>`; keys from `GET api.vercel.com/v1/api-keys?purpose=ai-gateway` |
| Vercel (billing) | no | no | project (FOCUS `Tags.ProjectId/ProjectName`) | one per charge | `GET /v1/billing/charges` (unchanged) |
| Windsurf | no (usage only; cost is flat seats) | no | no | one org row | unchanged |
| Apify | no | no | no | one org row | unchanged (account-scoped) |
| Manual / ChatGPT | no | no | no | n/a | manual entry, no `attribution` (counts as org) |

## Provider notes

### Anthropic API (`anthropic.ts`, `anthropic-analytics.ts`)

- The actor maps to attribution like this:
  - `user_actor` gives a person: `email_address` (lower-cased), `user_id` and `name`.
  - `api_actor` gives its `api_key_id`.
  - `service_account_actor` and `federated_actor` are not people. Their ids go in
    `metadata.service_account_id` and `metadata.federated_*`, and the row falls
    back to its `api_key_id` or `workspace_id` if it has one, else `org`.
  - Rows with a null actor are `org`.
- Amounts are cents as decimal strings, so the collector divides by 100.
  `list_amount` goes to `metadata.list_amount_usd`.
- Analytics data refreshes within 4 to 24 hours. The daily pull covers today
  plus the prior 3 UTC days, and backfill still works. Each request spans at
  most 31 days, uses `limit=1000` and is paginated. A 410 (cursor expired after
  a refresh) restarts pagination from page 1.
- **Fallback:** if analytics returns 403 or 404, the collector uses the legacy
  `cost_report` and `usage_report/messages`, both grouped by `workspace_id`.
  Those rows are `workspace`, or `org` for the default workspace, whose
  `workspace_id` is null. Any other error still fails the run, so a real
  outage is never hidden. `metadata.source` records which path produced a row
  (`analytics` or `cost_report`).

### Claude.ai Enterprise (`claude-ai.ts`)

- Uses the same analytics endpoints with an Analytics key that has the
  `read:analytics` scope. Unlike the legacy report, which keeps only the top 100
  groups per bucket, the analytics endpoint returns every group, so per-person
  rows sum to the full org total. The fixture test uses 150+ people in one day.
- Cost is still the source of truth: one row per cost group, with usage joined
  in on the identical group. The 30-day revision lookback from PR #2 is kept.
- The same 403/404 fallback to the legacy reports applies. Those rows are `org`.

### OpenAI (`openai.ts`)

- `/costs` is grouped by `line_item, project_id, api_key_id`. The public docs
  list only `project_id` and `line_item` for costs, so if the API rejects
  `api_key_id` with a 400, the collector retries without it. Rows are then
  `project`, and usage is joined on project only.
- Tokens come from `/usage/completions`. Usage is summed over `user_id`
  because cost has no user dimension. The distinct user ids go in
  `metadata.usage_user_ids`, a hint for mapping keys to people in #5 and #7,
  not an attribution.
- Project and key names are fetched best-effort. A failed lookup leaves names
  null and never fails collection. The key owner's email goes in
  `metadata.api_key_owner_email`: that is who created the key, which may not be
  who spends on it, so it is not used as `person_email`.

### Vercel AI Gateway (`vercel-ai-gateway.ts`)

- `/v1/report` takes a single `group_by`, so the collector runs one unfiltered
  `group_by=day` query and then one query per gateway key with `api_key_id=<id>`.
- Each day gets:
  - one `api_key` row for every key with activity, and
  - one `org` row with `metadata.remainder: true` holding the unfiltered total
    minus the per-key sum, emitted only when the remainder is nonzero.
- Listing keys needs a Vercel token, so the runner passes the optional
  `VERCEL_TOKEN` as `ctx.auxApiKey`. Without it, or if the key list is empty,
  only org rows are written.
- The split is all-or-nothing: if any per-key query fails, the collector writes
  org rows only. A partial split would misattribute the remainder.
- Report queries are billed at $5 per 1,000, so each run costs 1 + N queries
  for N keys. The key list follows `pagination.next` (sent as `until`) and is
  capped at 200; keys past the cap land in the remainder row.
- Per-user rows would need apps to send `user` and a separate `group_by=user`
  query. That isn't done yet.

### Cursor, Vercel billing, Windsurf, Apify

- Cursor: `member_email` is lower-cased into `person_email` with
  `granularity: "person"`. Events with no email stay `org`.
- Vercel billing: FOCUS `Tags.ProjectId` / `ProjectName` become `project`.
  Team-level charges such as plan fees and seats stay `org`.
- Windsurf: cost is a flat seat subscription split evenly per day, so no cost
  belongs to any one person or key. Usage per member exists, but attributing a
  seat fee by usage would invent numbers. Rows are `org`.
- Apify: the token and usage API are account-scoped, with no user, key or
  project dimension. Rows are `org`.

## Gaps and follow-ups

- OpenAI cost by person: the cost API has no `user_id` grouping. Map keys to
  people instead (#5 API keys table).
- Anthropic and Claude.ai service accounts, federated actors and `rbac_group_id`
  are kept in metadata only. The contract has no field for them.
- AI Gateway per-user and per-tag spend is not collected.
- The OpenAI `/costs` `api_key_id` grouping and the AI Gateway key-listing
  response shape could not be confirmed from the official docs while this was
  built. Both paths degrade safely (retry without the key grouping, or fall back
  to org rows) instead of failing.

## Dashboard coverage notes

The dashboard (#8) shows each provider's coverage next to org breakdowns, so a
provider that can't attribute spend to a person or key isn't read as $0. Those
notes come from `frontend/lib/org/coverage.ts`, which mirrors the table above:
update both together.
