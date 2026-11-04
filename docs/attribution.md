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
| Vercel AI Gateway | via the key: its creator by default (any `spendAttribution`, issue #34), or an admin-set owner | yes | project, for project-scoped keys (tags not collected) | one per key with spend, plus an org remainder | `GET ai-gateway.vercel.sh/v1/report?group_by=day` once unfiltered and once per key with `api_key_id=<id>`; keys from `GET api.vercel.com/v1/api-keys?purpose=ai-gateway`, project names from `GET /v9/projects/{id}`, creator emails from `GET /v3/teams/{teamId}/members` |
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
- **Workspace as project (issue #32):** analytics and legacy rows with a
  `workspace_id` also carry `attribution.project_id = workspace_id` (plus
  `project_name` when known), so the rollup resolves the workspace's
  `org_projects` row and its team. Granularity is unchanged (a workspace-only
  row stays `workspace`). Default-workspace rows (`workspace_id` null) get no
  `project_id`; their keys carry the "Default" project instead.

### Claude.ai Enterprise (`claude-ai.ts`)

- Uses the same analytics endpoints with an Analytics key that has the
  `read:analytics` scope. Unlike the legacy report, which keeps only the top 100
  groups per bucket, the analytics endpoint returns every group, so per-person
  rows sum to the full org total. The fixture test uses 150+ people in one day.
- Cost is still the source of truth: one row per cost group, with usage joined
  in on the identical group. The 30-day revision lookback from PR #2 is kept.
- The same 403/404 fallback to the legacy reports applies. Those rows are `org`.
- Spend by product (issue #48): every row keeps the API's product in
  `metadata.group.product`. The dashboard (Claude.ai sub-rows in the Tools table
  and a "by product" card on the Dashboard tab) and the person view split
  Claude.ai spend into Claude Code (`claude_code`), Chat (`claude_chat`, `chat`,
  `claude_ai`) and Other (anything else, including legacy rows with no product).
  The rollups have no product column, so the routes read the period's Claude.ai
  `cost_records` with `product:metadata->group->>product` (no migration) and
  divide each rollup row (date x model, plus the attribution columns when
  filtered) in proportion to the raw records with the same key; a rollup row
  with no matching raw spend goes to Other. Slices are rounded by largest
  remainder, so Claude Code + Chat + Other equals the Claude.ai total to the
  cent. See `lib/claude-ai-products.ts`. If the raw read fails, the dashboard
  renders without the split.

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
  who spends on it, so it is not used as `person_email`. Instead the OpenAI key
  sync (issue #46, below) makes that creator the key's default owner when the
  email matches a person, which sits below the row's own person in precedence.

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

### AI Gateway keys to people, projects and teams (issues #24, #34)

AI Gateway spend lands on a person, a project or a team depending on the key:

| Key | Resolves to |
|---|---|
| any key with a creator (`spendAttribution` `user`, `team` or unset) | the key's creator by default (issue #34): `createdBy` → email (Vercel team members, else the creator email already stored on the key) → `people` (matched by email, else created with no team) → `owner_person_id` with `assignment_source = 'auto'`, then the person's team |
| project-scoped (`projectId` set) | its `org_projects` row (created by the sync). The owner and the project coexist on one key; the owner ranks above the project, so the project's team applies only when the key has no owner |
| no creator, or a creator with no email | no owner (`unresolved_reason` `no_creator` or `unmatched_creator`); the project's team if scoped, else Unassigned until an admin assigns a person, project or team |
| no key (OIDC, PAT, app tokens) | the org remainder row, always org-level (see below) |

The **key sync** (`frontend/lib/org/gateway-sync.ts`) runs after every
`vercel-ai-gateway` collection (best-effort; its result is in the collection
summary as `key_sync`, and a failure never fails collection) and from
"Sync keys now" on `/admin` and `/admin/org` (issue #28; now
`POST /api/admin/org/keys/sync`, which also runs the Anthropic key sync, issue
#32; `POST /api/admin/org/keys/sync-gateway` still syncs gateway keys only). It upserts one `org_api_keys` row per gateway key,
whether or not the key has spend yet, with its name, creator, creator email and
`spend_attribution`, and auto-assigns the owner and project with
`assignment_source = 'auto'`. It returns `created`, `updated`, `unchanged`,
`manual_kept` and `unresolved_creators` counts, plus
`creator_default_assigned` (issue #34): the number of `team` / unset keys
whose owner this run set to their creator. Those keys are also counted in
`created` or `updated`. The key list is strict: if Vercel's key list fails, the
sync writes nothing and the route answers 502 with the reason (after a
collection the failure shows in `key_sync`). Team-member and project-name
lookups stay best-effort.

**Manual assignments win.** Setting a key's owner, team or project in the admin
UI or API marks it `assignment_source = 'manual'` (shown as a badge), and the
sync then only refreshes the creator and `spend_attribution` columns. A key with
no source but an owner, team or project already set counts as manual too. The
sync never sets a key's team, and never renames a project or changes its team.
Team members are fetched whenever any key has a `createdBy`. If the members
list can't be read completely on a run (a failed page, or no `VERCEL_TEAM_ID`),
a creator missing from it is a transient gap: the key keeps its existing auto
owner, creator email and reason, and isn't counted as unresolved. A key that
switches between `user` and `team` keeps its creator as owner.

**Creator is the default owner (issue #34).** Every non-manual gateway key
whose creator resolves to an email is owned by that creator's person
(`assignment_source = 'auto'`), whatever its spend attribution. Keys whose
creator doesn't resolve get no owner and a reason in `unresolved_reason`
(migration 017), counted in `unresolved_creators` and listed under
"Unassigned keys" on `/admin/org` with the same labels as Anthropic keys:

- `no_creator`: the key has no `createdBy`;
- `unmatched_creator`: the `createdBy` isn't in the (complete) team members
  list, or has no email, and no creator email is stored on the key yet.

The reason is cleared once the key resolves; manual keys never carry one.

**Backfill without a migration.** Existing keys pick up the rule on the next
"Sync keys now" (`/admin` or `/admin/org`) or the next `vercel-ai-gateway`
collection: a non-manual `team` or unset key with a creator email gets its
auto owner (reported in `creator_default_assigned`). No one-time SQL is
needed. Gateway spend with no key id (the pre-Aug-5, 2026 org-level history
and the daily `remainder` rows) can't be reached by this rule and stays
Unassigned.

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

### Anthropic keys to their creator, workspaces as projects (issue #32)

The **Anthropic key sync** (`frontend/lib/org/anthropic-key-sync.ts`) uses the
anthropic provider's Admin key to list `GET /v1/organizations/api_keys` (every
status, `limit=1000`, paged by `after_id`), `GET /v1/organizations/users` and
`GET /v1/organizations/workspaces?include_default=true&include_archived=true`.

- **Workspaces become projects.** One `org_projects` row per workspace
  (provider anthropic, external id = workspace id, the workspace name). The
  default workspace (keys with `workspace_id` null) is the project `default`
  named **"Default"**. An existing project only gets a missing name filled in;
  a name or team set by hand is never changed.
- **Keys.** One `org_api_keys` row per key, archived keys included: name,
  status (`external_status`, migration 017), creator id and email,
  `org_project_id` = the workspace project, `spend_attribution` NULL.
- **Auto owner.** `principal.user_id`, else `created_by.id` when it is a user →
  email (users list) → `people` (matched by email, else created with no team)
  → `owner_person_id`, `assignment_source = 'auto'`.
- **No owner, reason stored** (`unresolved_reason`, counted in
  `unresolved_creators` and listed under "Unassigned keys" on `/admin/org`):
  `service_account` (a non-user creator, stored as `type:id` in
  `external_created_by`), `deleted_user` (not in the users list),
  `unmatched_creator` (a user with no email) and `no_creator`.
- **Manual wins.** A key with `assignment_source = 'manual'` (or an owner,
  team or project set before 015) keeps its owner, team and project; only
  metadata refreshes. If the users list fails, the existing owner, email and
  reason are kept.

It runs best-effort after every `anthropic` collection (a failure never fails
collection; the result is `key_sync` in the summary) and from **"Sync keys
now"** (`POST /api/admin/org/keys/sync`, on `/admin` per provider and on
`/admin/org` for both). That route lists every requested provider's keys
before writing: an Anthropic Admin API or Vercel key-list error is a 502 and
nothing is written. It returns `created`, `updated`, `unchanged`,
`manual_kept` and `unresolved_creators` per provider. Users, team members,
workspaces and project names stay best-effort. Migration 017 is optional at
runtime: without it, status and reason aren't stored and everything else works.

**Vercel "Assign to creator" (override).** The gateway sync already makes the
creator every key's default owner (issue #34), so this is a manual override.
On `/admin/org` ("API keys & projects"), any gateway key (any spend
attribution) that has a creator email and whose owner isn't that creator's
person (no owner, or a key handed to someone else) shows a one-click "Assign
to creator" (`POST /api/admin/org/keys/assign-creator`). It sets the owner to
the creator's person (matched by email, else created with no team) with
`assignment_source = 'manual'`, so a later "Sync keys now" leaves it alone.
Keys already owned by their creator don't show it (the route answers 409).

### OpenAI keys to their creator, projects as projects (issue #46)

The **OpenAI key sync** (`frontend/lib/org/openai-key-sync.ts`) uses the
openai provider's Admin key (and `OPENAI_ORG_ID` when set) to list
`GET /v1/organization/projects?include_archived=true` and each project's
`GET /v1/organization/projects/{id}/api_keys`, then adds every key seen on the
openai cost rows that the API no longer lists (deleted keys), with the
creator taken from `metadata.api_key_owner_email`.

- **Projects.** One `org_projects` row per OpenAI project (provider openai,
  external id = project id). Existing projects only get a missing name.
- **Keys.** One `org_api_keys` row per key: name, creator id and email,
  `org_project_id` = its project, `spend_attribution` NULL. No status is stored.
- **Auto owner, only for a matching person.** The creator's email
  (`owner.user.email`, else `api_key_owner_email`) is matched to `people.email`,
  else to an openai `person_identities` row with that email as external id.
  A match becomes `owner_person_id` with `assignment_source = 'auto'`. Unlike
  the Anthropic and gateway syncs, **no person is created**.
- **No owner, reason stored:** `unmatched_creator` (the email matches no
  person, or the user has no email; shown as "creator's email matches no
  person" for OpenAI keys), `service_account`, and `no_creator`. A key known
  only from cost rows whose rows never recorded a creator keeps whatever owner
  and email it already had.
- **Manual wins**, exactly as for Anthropic: the sync only refreshes metadata
  on a manual key.

It runs best-effort after every `openai` collection (deleted keys come from
the records just collected) and from **"Sync keys now"** (which scans the
openai cost rows for deleted keys, best-effort). The project and key lists are
strict there: an OpenAI Admin API error is a 502 and nothing is written. The
summary adds `keys_from_cost_records`; `people_created` is always 0.
OpenAI keys then show in the `/admin/org` keys tab under their project and in
a person's key list (issue #35) like any other owned key.

**No migration (019 is not needed).** `org_api_keys` has no provider
constraint and 017's `unresolved_reason` values cover every OpenAI case.
Without 017 the sync skips `unresolved_reason` and works otherwise.

#### Attribution precedence

| # | Rule | Where |
|---|---|---|
| 1 | The person who actually used the key (`user_actor` / principal on the cost row) | `person_email` / `person_external_id` on the row beat the key owner |
| 2 | An owner set by hand (`assignment_source = 'manual'`); the sync never overwrites it | `org_api_keys.owner_person_id` |
| 3 | The automatic creator owner (`assignment_source = 'auto'`), for Anthropic keys, since issue #34 every gateway spend-attribution mode, and since issue #46 OpenAI keys whose creator email matches a person | `org_api_keys.owner_person_id` |
| 4 | The key's project (Anthropic workspace, Vercel project, OpenAI project), then that project's team | row `project_id`, else the key's `org_project_id` |
| 5 | Unassigned | no person and no team |

The view (`cost_records_daily_attributed`) is unchanged: these rules already
hold. Team is still **key team > person team > project team**, so the actor's
team wins on a user_actor row unless an admin set a team on the key itself.
Checked by `lib/org/attribution.test.ts`, `lib/org/anthropic-key-sync.test.ts`,
`lib/org/openai-key-sync.test.ts`,
`lib/org/gateway-sync.test.ts` (including a totals-unchanged check: summed
cost per provider and day is identical before and after the sync) and
`scripts/migration-tests/assertions_017.sql`.

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

### Keys under projects and workspaces (issue #28)

`/admin/org` ("API keys by project") and the dashboard API keys table group keys
by provider, then project (OpenAI `project_id`), workspace (Anthropic
`workspace_id`, else "Default workspace") or Vercel project (the key's
`org_project_id` or its rows' `project_id`, else "No project"), via
`frontend/lib/org/key-groups.ts`. Registered keys with no spend are listed.

#### Keys a filter owns (issue #35)

On the dashboard, a person, team or department filter lists the keys that
selection owns, even with $0 in the period: person = `owner_person_id`; team =
the key's `team_id` or its owner's team; department = those teams'
department. Keys with spend in the filtered rows (for example someone else's
key used by this person) are listed too. A key filter lists that key. An
`unassigned` filter value owns nothing, so it lists only keys with spend.
Provider and project filters apply on top. This is display only: totals and
the department / team / person / key tables don't change.

#### Key table filters and "Consider revoking" (issue #45)

Both key tables hide keys with $0 spend by default (dashboard: the selected
period; `/admin/org`: all collected data, since that page has no period) and
say how many are shown ("119 of 594 keys with spend"). "Show $0 keys" lists
them all. A search box matches name, owner or key id, and status chips
(active / inactive / deleted, where Anthropic's `archived` is "deleted", plus
"no status" for providers that don't report one) narrow further. Chip counts
reflect the spend filter and search. Filters only drop rows; the table order
is unchanged. The logic is `frontend/lib/org/key-filter.ts`.

"Consider revoking" lists active keys with $0 in the last 90 days (whatever the
selected period), with owner and last spend date, never-spent keys first. It is
read-only. The provider's key creation date (`org_api_keys.provider_created_at`,
migration 018 from #44) shows when that column exists; without it the column is
left out and nothing fails.

The key syncs fill `provider_created_at` (issue #44) from Anthropic's
`created_at` (RFC 3339), OpenAI's `created_at` (epoch seconds) and Vercel's
`createdAt` (epoch ms) when the provider reports one. A listing without a date
(e.g. an OpenAI key seen only on cost rows) keeps the stored date. Our own
`created_at` remains the date the row was first synced.

### Needs-review inbox (issue #44)

`/admin/org` → **Needs review** lists, computed live from
`cost_records_daily_attributed` (`frontend/lib/org/review-inbox.ts`):

- **Person spikes**: a person's month spend over 2x the previous month and
  over $500, for the last complete month (actual) and the current month (the
  #39 projection, labelled projected). No spend the month before counts once
  over $500.
- **Person-days**: one person's spend on one day over $300 (all providers),
  from the 1st of the last complete month.
- **Newly unassigned spend**: spend with no team, grouped by person, else API
  key, else project, else provider, whose group was first seen in the last 7
  days (today included).
- **Newly active keys**: keys whose `provider_created_at` is in the last 7 days
  and that have spend since. Keys without a stored provider date never show.

Acknowledge (or Assign, which runs the Unassigned queue's assign flow) records
the item and its amount in `review_items` (migration 018) with an optional
note. The item stays hidden until its amount exceeds 1.25x the recorded amount,
then comes back showing the earlier decision. Without 018 the items still
list, Acknowledge is hidden behind a "migration 018 not applied" notice, and
`POST /api/admin/org/review` answers 409 `migration_018_not_applied`.

### Budgets and alerts (issue #49)

`/admin/org` → **Budgets** keeps one monthly USD budget per person, team or
project (`budgets`, migration 020). Spend maps to a subject the same way the
dashboard filters do: `person_id`, `team_id`, and a project is the row's
provider + `project_id` (else `workspace_id`) looked up in `org_projects`. The
current month is projected with #39 (`frontend/lib/budgets.ts`) and each budget
is **over** (actual already over), **projected over** (projection over, actual
under) or **on track**. Over and projected-over subjects show in Needs review
as **Projected over budget** (`budget_over`, acknowledgeable like the others
when 018 and 020 are applied).

`/api/cron/budget-alerts` (daily, 09:30 UTC) sends one alert per subject per
month (`alert_log`, UNIQUE subject + month + dry_run) for projected overruns
and the inbox's person spikes; an overrun and a spike for the same subject and
month are one message. The row is claimed before sending, and released when
every channel fails so the next run retries. Dry-run is the default and logs
without sending; dry-run and live rows are deduped separately. Channels come
only from env var names (`BUDGET_ALERTS_MODE`, `BUDGET_ALERT_SLACK_WEBHOOK_URL`,
`BUDGET_ALERT_EMAIL_TO`, `BUDGET_ALERT_EMAIL_FROM`, `RESEND_API_KEY`); live
mode with none configured sends and logs nothing. Without 020 the tab shows
"migration 020 not applied", writes answer 409 `migration_020_not_applied`,
and the cron returns `status: "migration_020_not_applied"`.

On the dashboard, an Anthropic `workspace_id` stands in for a missing
`project_id`: the Projects table shows workspaces (marked "workspace") and the
`project` filter matches either column. The table shows whenever any loaded row
carries a project or workspace. Workspace names live in `org_projects` (same
provider + external id key), and admins can name them on `/admin/org`.
Since issue #32 Anthropic rows carry `project_id = workspace_id`, so a
workspace's `org_projects` team applies through the existing `project_id`
join (no view change), and the Anthropic key sync registers every workspace
(the default one as "Default"). OpenAI and Vercel projects are still created
when an admin names or assigns one, or by the gateway key sync.
