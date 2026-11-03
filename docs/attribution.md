# Cost attribution in collectors

Collectors write sub-org attribution to `cost_records.metadata.attribution`,
following the shared contract from epic #4 (`Attribution`, defined in
`frontend/lib/org/types.ts` and re-exported from
`frontend/lib/collectors/types.ts`):

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
| Vercel AI Gateway | via the key: creator when `spendAttribution = user`, or an admin-set owner | yes | project, for project-scoped keys (tags not collected) | one per key with spend, plus an org remainder | `GET ai-gateway.vercel.sh/v1/report?group_by=day` once unfiltered and once per key with `api_key_id=<id>`; keys from `GET api.vercel.com/v1/api-keys?purpose=ai-gateway`, project names from `GET /v9/projects/{id}`, creator emails from `GET /v3/teams/{teamId}/members` |
| Manual (not seat-based) | no | no | no | n/a | manual entry, no `attribution` (counts as org) |
| Seat-based manual tools (Claude Ultra `claude-max`, ChatGPT, Lovable) | yes, once an admin assigns seats | no | no | one row per assigned person plus an org remainder, per month | Seat assignments (admin), `PUT /api/admin/seat-assignments` |

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
- Each key's settings ride along on its rows (issue #24). The key list returns
  `projectId` (set when the key is scoped to one project), `createdBy` (Vercel
  user id) and `metadata.spendAttribution` (`user` | `team`; unset counts as
  team). They go in `metadata.gateway_key` (`project_id`, `created_by`,
  `spend_attribution`). A project-scoped key's rows also set
  `attribution.project_id`, plus `project_name` from a best-effort
  `GET /v9/projects/{id}`; a failed lookup leaves the name null and never fails
  collection. `api_key_id` stays the primary dimension (`granularity:
  "api_key"`), and the remainder rule and all-or-nothing fallback are unchanged.

### AI Gateway keys to people, projects and teams (issue #24)

AI Gateway spend lands on a person, a project or a team depending on the key:

| Key | Resolves to |
|---|---|
| `spendAttribution = user` | the key's creator: `createdBy` → email (Vercel team members) → `people` (matched by email, else created with no team) → `owner_person_id`, then the person's team |
| project-scoped (`projectId` set) | its `org_projects` row (created by the sync), then the project's team once an admin sets one |
| `spendAttribution = team` or unset, not scoped | nothing until an admin assigns a person, project or team ("Unassigned gateway keys" on `/admin/org`) |
| no key (OIDC, PAT, app tokens) | the org remainder row, always org-level (see below) |

The **key sync** (`frontend/lib/org/gateway-sync.ts`) runs after every
`vercel-ai-gateway` collection (best-effort; its result is in the collection
summary as `key_sync`, and a failure never fails collection) and from
`POST /api/admin/org/keys/sync-gateway` ("Sync gateway keys" on `/admin/org`).
It upserts one `org_api_keys` row per gateway key with its name, creator,
creator email and `spend_attribution`, and auto-assigns the owner and project
with `assignment_source = 'auto'`.

**Manual assignments win.** Setting a key's owner, team or project in the admin
UI or API marks it `assignment_source = 'manual'` (shown as a badge), and the
sync then only refreshes the creator and `spend_attribution` columns. A key with
no source but an owner, team or project already set counts as manual too. The
sync never sets a key's team, and never renames a project or changes its team.
If the creator's email can't be read on a run, an existing auto owner is kept;
if a key switches to `team`, its auto owner is cleared.

Team precedence in `cost_records_daily_attributed` (migration 015) and
`frontend/lib/org/attribution.ts`: the person is resolved first (the key's
owner for gateway rows); then team = **key team > person team > project team**,
where the project is the row's `attribution.project_id`, else the key's
assigned `org_project_id` (same provider only). The project drill-down on the
dashboard uses the same effective project.

**OIDC, PAT and app-token spend stays org-level.** Vercel ties OIDC requests to
a project for budgets, but `/v1/report` has no project grouping or filter, and
those requests have no gateway key to split by. That spend stays in the
remainder row (Unassigned) unless apps send a project tag, for example an
`ai-reporting-tags: project:<name>` header (or
`providerOptions.gateway.tags`). Collecting tag-based attribution is out of
scope here; it would need a separate `group_by=tags` query.

History collected before the per-key collector has no attribution. After
deploying, re-pull it with the backfill command in the README ("Re-pulling AI
Gateway history").

### Cursor

- Cursor: `member_email` is lower-cased into `person_email` with
  `granularity: "person"`. Events with no email stay `org`.

The Vercel (hosting usage), Apify and Windsurf collectors were removed in #27
after those tools were deleted from the dashboard. They had no attribution
finer than `project` (Vercel billing) or `org` (Apify, Windsurf).

### Seat-based manual tools (issue #26)

Claude Ultra (formerly Claude Max; the provider slug stays `claude-max`) and
other seat-based manual tools (providers with `metadata.billing = 'seat'`) are
entered as one `manual_entry` row per month (`model_name 'seats'`,
`request_count` = seats, `metadata.entry_type = 'monthly_seats'`). The admin
**Seat assignments** card splits a month into:

- one row per person: `attribution = { granularity: "person", person_email }`,
  `seats`, and a cost that defaults to seats × `price_per_seat`;
- one remainder row for unassigned seats: `attribution = { granularity: "org" }`,
  `remainder: true` (left out when nothing remains).

Every row keeps `entry_type`, `month`, `price_per_seat`, `cost_basis`, `notes`,
the original timestamp and owner, and shares `metadata.seat_group_id` (plus
`seat_group_total_usd` / `seat_group_total_seats`). The rows sum to the month's
original total exactly (micro-dollars; the remainder absorbs rounding).
Re-assigning replaces the set in one transaction through `replace_seat_group()`
(migration 016), which refuses a set whose sum differs from the rows it
replaces. Clearing all assignments collapses the month back to one plain entry.
The view already resolves `person_email` to the person and their team, so the
People table, person drill-down and team/department roll-ups pick it up.
Emails not in `people` are added (no team). Manage entries lists a split month
as one item and deletes it as a set; its rows can't be edited one by one.

## Gaps and follow-ups

- OpenAI cost by person: the cost API has no `user_id` grouping. Map keys to
  people instead (#5 API keys table).
- Anthropic and Claude.ai service accounts, federated actors and `rbac_group_id`
  are kept in metadata only. The contract has no field for them.
- AI Gateway per-user and per-tag spend is not collected, so OIDC, PAT and
  app-token spend stays org-level even when apps send a project tag.
- The OpenAI `/costs` `api_key_id` grouping and the AI Gateway key-listing
  response shape could not be confirmed from the official docs while this was
  built. Both paths degrade safely (retry without the key grouping, or fall back
  to org rows) instead of failing.

## Dashboard coverage notes

The dashboard (#8) shows each provider's coverage next to org breakdowns, so a
provider that can't attribute spend to a person or key isn't read as $0. Those
notes come from `frontend/lib/org/coverage.ts`, which mirrors the table above:
update both together. The dashboard also has a Projects table and a `project`
filter (the view's effective `project_id`).
