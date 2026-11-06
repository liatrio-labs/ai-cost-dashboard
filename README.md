# AI Cost Dashboard

A Liatrio-branded dashboard for tracking AI spend across every tool the org uses —
automated daily collection, a shared team view, and a headcount-driven forecast.

> Internal tool for **Liatrio**. Access is restricted to `@liatrio.com` Google accounts.

## Overview

The dashboard gives one place to answer "what are we spending on AI, where, and where
is it heading?" Cost data is collected automatically every day from each provider's
billing/usage API, normalized into a single store, and rendered as KPIs, breakdowns,
trends, and a forecast. Tools without a usable cost API are entered manually.

## Features

- 📊 **Unified spend dashboard** — KPI cards (period total, top tool/model), spend
  breakdown by tool, breakdown by model, and a monthly trend chart.
- 🔮 **Forecast** — a saturating, **headcount-driven** projection to year-end (closes a
  fixed fraction of the gap to a plateau each month; the plateau scales with employee
  count). Editable from the admin area. Filtering the dashboard to a team or department
  projects that unit: its plateau is the org plateau times its trailing 3-month share of
  attributed spend (Unassigned is its own unit, so units sum to the org forecast), with
  optional per-unit plateau or headcount overrides in the admin area. Person, API-key and
  project views show the projected current month and a trailing 3-month average of complete
  months instead.
- 📈 **Projected current month** — while a period is in progress, every trend (KPI cards,
  tools table, the Change column in the org tables) compares a **projected** period total with
  the previous full period and is labelled "projected", instead of a partial month vs a full
  one. Spend Trends and Spend Forecast draw actuals solid through the last complete month and
  the current month dotted. Weekday-aware, lag-aware and seat-aware; see
  [docs/projections.md](docs/projections.md). Actual totals are never changed.
- 🗂️ **Tools table** — per-tool spend, description, a link to the provider's billing
  console, and a "Last updated" timestamp.
- 🔁 **Automated daily collection** — Vercel Cron triggers in-process TypeScript
  collectors; idempotent (delete-then-insert per day) so re-runs never double-count.
- 🕒 **Sync freshness** — dashboard and admin show each provider's last sync (America/Chicago),
  warn when a provider missed its `vercel.json` cron (scheduled run + 60 min grace), and
  remind admins from day 4 when a manual provider such as ChatGPT has no entry for the month
  (`frontend/lib/sync-freshness.ts`, `GET /api/dashboard/freshness`).
- 🛠️ **Admin area** — trigger a manual pull, add tools, record manual/seat-based monthly
  entries, edit the forecast headcount, and force a dashboard refresh.
- 💳 **Seat assignments** — split a seat-based tool's month (Claude Ultra, formerly
  Claude Max, slug `claude-max`; ChatGPT; Lovable) across the people who hold the
  seats. Per-person rows plus an Unassigned remainder; the month's total never changes.
- 🗓️ **Period selection** — view any month or a custom date range.
- 🔐 **Google SSO** — Supabase Auth, restricted to the `@liatrio.com` domain.
- 🌙 **Dark mode + Liatrio brand** — Space Grotesk, brand palette, logomark favicon,
  and a System / Light / Dark toggle that follows the OS by default.

## Data sources

Each provider has a dedicated collector (`frontend/lib/collectors/`) keyed off an
org-level API token in environment variables. Missing key → that provider is skipped.

| Provider | Source | Notes |
|---|---|---|
| **Anthropic API** | Admin usage/cost report | platform.claude.com |
| **Claude.ai (Enterprise)** | Enterprise Analytics API | per-user + org cost reports |
| **OpenAI API** | `/v1/organization/costs` | requires `OPENAI_ORG_ID` |
| **Cursor** | Admin `filtered-usage-events` | per-day × member × model |
| **Vercel AI Gateway** | Custom Reporting API | separate from Vercel billing |
| **ChatGPT / Lovable / other** | Manual entry / CSV import | no usable cost API |

Rows carry `metadata.attribution` (person / API key / project / workspace, or
`org` when the provider exposes nothing finer). See
[docs/attribution.md](docs/attribution.md) for what each provider supports and
which endpoints are used. The AI Gateway collector also uses `VERCEL_TOKEN`
(optional) to list gateway keys for per-key rows. The Vercel (hosting usage),
Apify and Windsurf collectors were removed in #27 after those tools were
deleted from the dashboard.

### Daily refetch windows and coverage

Provider usage keeps settling after a UTC day ends, so each daily (non-backfill)
cron re-fetches a trailing window and overwrites it:

| Collector | Daily window | Constant |
|---|---|---|
| `anthropic` | today + prior 7 UTC days | `DEFAULT_LOOKBACK_DAYS` in `lib/collectors/anthropic.ts` |
| `openai` | today + prior 7 UTC days | `DEFAULT_LOOKBACK_DAYS` in `lib/collectors/openai.ts` |
| `claude-ai` | today + prior 30 UTC days (31 buckets) | `DEFAULT_LOOKBACK_DAYS` in `lib/collectors/claude-ai.ts` |

`storeRecords()` deletes every `api_automated` row for the provider at each
re-fetched bucket timestamp and inserts the new set, so a revised day (higher or
lower) ends up with exactly the new rows, and an old org-level row (e.g. an
Anthropic `model = 'unknown'` row) at that timestamp is replaced, not added to.
Manual and CSV rows are never touched.

OpenAI `/costs` is grouped by `api_key_id` when the org allows it and falls back
to `line_item,project_id` on a 400. Each run logs one line
(`[openai] costs grouping=api_key ...` or `[openai] costs grouping=fallback status=400 ...`)
and the cron JSON carries the same flag at `result.details.costs_grouping`.

Missing or short days are reported by **`GET /api/admin/coverage?provider=&days=`**
(admin only, read-only). It reads `cost_records_daily` and flags each of the last
`days` complete UTC days (default 7, max 90) that is missing, or below 25% of that
provider's trailing 14-day median. Providers with a $0 median and days with no
history are ignored. The logic is the pure `findCoverageGaps` in
`lib/collectors/coverage.ts`. Results reflect the last materialized-view refresh.

## Tech stack

- **Framework:** Next.js 16 (App Router) · React 19 · TypeScript
- **UI:** Tailwind CSS v4 · Radix UI primitives · Recharts · Space Grotesk
- **Data:** Supabase (Postgres) — shared read for all authenticated users; a
  `cost_records_daily` materialized view powers the dashboard
- **Auth:** Supabase Auth (Google OAuth, `@liatrio.com`-gated)
- **Collection:** in-process TypeScript collectors invoked by **Vercel Cron**
- **Monitoring:** Sentry
- **Hosting:** Vercel (single project)

## Architecture

```
Vercel Cron ──> /api/cron/<provider> ──> TS collector ──> Supabase (cost_records)
                                                              │
            Browser ──> Next.js (App Router) ──> /api/dashboard ──> cost_records_daily (mat. view)
                                                              │
                                              headcount-driven forecast (app_settings)
```

Everything runs in the one Next.js app on Vercel — there is **no separate backend
service**. Collection is in-process; the cron routes only authenticate the request
(via `CRON_SECRET`) and call the collector directly.

## Access & roles

- Sign-in is **Google-only**, restricted to the `@liatrio.com` domain.
- **Admins** reach `/admin`, `/admin/org` and the admin-only parts of the dashboard. An
  admin is either on the env allowlist (`ADMIN_EMAILS`, else `DASHBOARD_OWNER_EMAIL`, else
  `robert@liatrio.com`; always admin, not removable in the UI) or was added in the
  **Admins** section on `/admin` (stored in `admin_users`, migration 023; `@liatrio.com`
  addresses only; you can't remove yourself). Being `@liatrio.com` alone does **not** make
  you an admin. `ADMIN_DOMAINS` (comma-separated) still grants a whole domain, but only
  when set explicitly; it has no default. Without migration 023 only env admins exist and
  the Admins section shows a "migration 023 not applied" notice.
- The dashboard data is shared — all authenticated users see the same org-wide spend.
- `/admin/org` manages departments, teams, people (and their provider identities),
  API key and project ownership, imports people from emails seen in collected data
  (dry run, then confirm), and shows the monthly Unassigned queue with one-click
  assign. Its API lives under `/api/admin/org/*`, behind the same admin check.

## Project structure

```
ai-cost-dashboard/
├── frontend/                 # The application (Next.js, deployed to Vercel)
│   ├── app/                  # App Router pages + API routes (incl. /api/cron/*)
│   ├── components/           # Dashboard, charts, admin, and UI components
│   ├── lib/
│   │   ├── collectors/       # Per-provider TypeScript collectors (+ tests)
│   │   ├── org/              # Org attribution + department/team/person/key rollups (+ tests)
│   │   ├── collection.ts     # Cron auth + collector dispatch
│   │   └── supabase/         # Browser/server/admin Supabase clients
│   └── vercel.json           # Cron schedule
├── database/                 # SQL migrations + schema notes (see database/README.md)
└── scripts/test-migrations.sh  # Applies all migrations to a throwaway Postgres 15 + SQL assertions
```

## Getting started (local)

```bash
cd frontend
npm install
cp .env.local.example .env.local   # fill in Supabase + provider keys
npm run dev                         # http://localhost:3000
```

Useful env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, the provider tokens (e.g.
`ANTHROPIC_ADMIN_KEY`, `OPENAI_ADMIN_KEY` + `OPENAI_ORG_ID`, `CURSOR_ADMIN_KEY`,
`AI_GATEWAY_API_KEY`, plus `VERCEL_TOKEN` and `VERCEL_TEAM_ID` for the AI Gateway
key sync), optionally `ADMIN_EMAILS` / `DASHBOARD_OWNER_EMAIL` and `ADMIN_DOMAINS` (no default), and the budget-alert vars (`BUDGET_ALERTS_MODE`,
`BUDGET_ALERT_SLACK_WEBHOOK_URL`, `BUDGET_ALERT_EMAIL_TO`, `BUDGET_ALERT_EMAIL_FROM`,
`RESEND_API_KEY`; see Budgets below).
Set `NEXT_PUBLIC_SKIP_AUTH=true` to bypass auth in local dev.

```bash
npm test            # unit tests (provider collectors)
npm run test:e2e    # Playwright auth/routing tests
npm run build       # production build
```

Migrations are checked against a throwaway local PostgreSQL 15 (unix socket only,
deleted on exit; never a remote database):

```bash
scripts/test-migrations.sh             # uses PG_BIN or an installed postgresql-15
FETCH_PG=1 scripts/test-migrations.sh  # or download PG 15 binaries from npm first
```

It applies 001-011 with a stub Supabase `auth` schema, re-applies 010 and 011 to prove they're
idempotent, seeds fixtures and runs the attribution/rollup assertions. See
`database/README.md`.

## Re-pulling history

`POST /api/admin/collect` can re-fetch an explicit range of UTC days for `anthropic`,
`claude-ai`, `openai` and `vercel-ai-gateway`, e.g. to replace old org-level rows with
attributed ones or fill a missing day. The `/admin` pull card has the same start/end
inputs; the range applies to those providers, and Cursor keeps the backfill toggle.

Cursor counts on-demand (usage-based) spend only (issue #73), matching `/teams/spend`
`spendCents`: events of kind "Included in Business" are stored with `cost_usd = 0` and
their charged value in `metadata.included_value_usd`, on their own rows
(`metadata.billing_tier`). A Cursor backfill (`{ "provider": "cursor", "backfill": true,
"backfill_days": 31 }`) re-pulls from 2026-11-01 at the earliest and never touches
October 2026 or earlier, so running it once after deploy corrects November onward.

Months before that (or any provider-month where usage disagrees with the bill) are
corrected with an **invoice actual** (issue #75, migration 024): in the Invoice actuals
section on `/admin`, an admin sets the invoiced amount for one provider and one complete
calendar month. That provider-month then counts exactly the invoice on the dashboard,
breakdowns, budgets and forecasts: its API rows are scaled proportionally (attribution to
people, teams and products is kept) and its manual entries and recurring cost are
replaced, not added. Clearing it restores the API, manual and recurring amounts. No
amounts are hardcoded; nothing in `cost_records` changes.

Cursor billing-cycle on-demand (issue #76) comes from the documented Admin API
`POST /teams/spend`, never the Cursor dashboard. Each member's on-demand for the current
billing cycle is `spendCents`; the team's cycle total is the sum of `spendCents`.
`overallSpendCents` (included plus on-demand) is stored and shown for context but never
used as billed on-demand. `/teams/spend` only reports the current cycle, so
`/api/cron/cursor-spend` snapshots it hourly (and every Cursor pull does too) into
migration 025's tables; when a cycle resets (e.g. Oct 19 to Nov 19) the previous cycle
keeps its last snapshot and the database refuses later changes to it. The Dashboard tab
shows the current cycle's dates, team on-demand total, per-member on-demand and limits
(`effectivePerUserLimitDollars`, with `hardLimitOverrideDollars` / `monthlyLimitDollars`),
and earlier cycles' final totals, labelled as billing-cycle figures distinct from the
calendar-month totals. Usage events stay the source for history, calendar months and the
by-product split. Without migration 025 the card shows a notice and nothing else changes.
Invoices, credits, seat fees and seat types are not in the documented Admin API and are
not shown.
Cursor **seat fees** (migration 026) are not in the Admin API either, so each person's
Cursor seat type (Standard / Premium / Free / unassigned) is set on `/admin/org` ->
People, and the monthly rates (initially Standard $40, Premium $80, Free $0) are edited in
the Cursor seats card there. Seats bill on a 20th-to-20th cycle (issue #82; anchor
`SEAT_CYCLE_ANCHOR_DAY` in `frontend/lib/cursor-seats.ts`): each billed person gets one
cycle's seat fee as Cursor spend in the calendar month the cycle starts in (Nov 20 - Dec 20
counts in November), attributed to them and their team. A seat type carries into every
later cycle until an admin changes it or sets it to Unassigned; changes apply from the
cycle billed in the current month (shown on the card) and never alter earlier cycles.
The Nov 5, 2026 roster is committed as seed data
(`database/seeds/cursor-seat-roster-2026-11-05.csv`, 74 Standard + 36 Premium + 1 Free =
$5,840); import it from the same card (matched by email, else exact name; unmatched rows
are listed, Removed rows get no seat). In a Cursor month with an invoice actual the seats
are part of the invoiced total, not added to it, and a recurring Cursor cost is not
counted in a month that has per-person seats.

Body: `{ "provider": "anthropic", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" }`.
`end_date` is inclusive, the span is at most 31 days and `end_date` can't be after today
(UTC). A `start_date` before the provider's earliest data is clamped to it (2026-01-01 for
Anthropic and Claude.ai analytics; 366 days back for OpenAI) and the response reports
`range.clamped: true`. AI Gateway is never clamped: Vercel documents no earliest date
for `/v1/report`, and days before the first gateway request just return no rows. Without the dates the old `{ provider, backfill, backfill_days }`
behaviour is unchanged; with them, `backfill` is ignored. The response includes the
effective `range`, `records_stored` and a per-day `days` list (`date`, `records`,
`cost_usd`, zeros for days the provider returned nothing for), and the daily rollup is
refreshed on success. The cron routes accept the same `start_date`/`end_date` query
params (with `CRON_SECRET`).

Auth is an admin session, or `Authorization: Bearer <COLLECTION_TRIGGER_SECRET>` for
scripts (compared in constant time; disabled when the env var is unset or empty).

```bash
BASE=https://your-deployment.example.com
SECRET=replace-with-collection-trigger-secret

# One day
curl -sS -X POST "$BASE/api/admin/collect" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","start_date":"2026-07-23","end_date":"2026-07-23"}'

# 31-day chunks from 2026-01-01 to yesterday (GNU date)
start=2026-01-01
last=$(date -u -d yesterday +%F)
while [[ ! "$start" > "$last" ]]; do
  end=$(date -u -d "$start +30 days" +%F)
  [[ "$end" > "$last" ]] && end=$last
  echo "== $start .. $end"
  curl -sS -X POST "$BASE/api/admin/collect" \
    -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
    -d "{\"provider\":\"anthropic\",\"start_date\":\"$start\",\"end_date\":\"$end\"}" \
    | jq '{status, records_stored, range, days}'
  start=$(date -u -d "$end +1 day" +%F)
done
```

### Re-pulling AI Gateway history

Vercel AI Gateway spend collected before the per-key collector was deployed has no
`metadata.attribution`, so it is all org-level. Re-pull it with the explicit-range path
above (31-day chunks with `"provider":"vercel-ai-gateway"`), or with the cron route's
trailing backfill in one call (one report call for the whole window plus one per
gateway key, inside the 300 s function limit). Either way it needs the same
`VERCEL_TOKEN` as the daily run to split per key, replaces each re-pulled day's rows as
a set (same rules as below), and runs the gateway key sync afterwards. **Operator step
after deploying migration 015 and this code; not run as part of the change.**

To register every gateway, Anthropic and OpenAI key (keys with no spend included)
without collecting, use **Sync keys now** on `/admin` (pull card, per provider) or
`/admin/org` ("API keys & projects", every provider). It reports created / updated /
unchanged / manual-kept / unresolved-creator counts per provider; a failed Vercel,
Anthropic or OpenAI key list is an error and changes nothing. Anthropic keys are assigned to their creator and
workspaces become projects (issue #32, see `docs/attribution.md`); the same sync runs
after every Anthropic collection. Migration 017 stores Anthropic key status and the
reason a key has no owner; the sync works without it. OpenAI keys are owned by their
creator when the creator's email matches an existing person (issue #46, no migration);
the same sync runs after every OpenAI collection. With migration 018 every sync also
stores the provider's key creation date (`provider_created_at`, issue #44).

`/admin/org` opens on **Needs review** (issue #44): person spikes (month spend over 2x
the previous month and over $500; the current month uses the projection), person-days
over $300, Unassigned spend first seen in the last 7 days and keys the provider created
in the last 7 days. Each item can be acknowledged or assigned (the existing assign
flow) with a note; it stays hidden unless its amount grows more than 25%. Without
migration 018 the items still show, with a "migration 018 not applied" notice and no
Acknowledge.

**Budgets** on `/admin/org` (issue #49) sets a monthly USD budget per person, team or
project. Each budget shows this month's actual and #39 projection, and a **Projected
over budget** badge when the projection is over; those subjects are also listed in
Needs review. A daily cron (`/api/cron/budget-alerts`, 09:30 UTC) alerts on projected
overruns and person spikes by Slack webhook and/or email, at most once per person,
team or project per month. It is **dry-run by default** (alerts are logged to
`alert_log`, nothing is sent) and is configured only by env vars:
`BUDGET_ALERTS_MODE=live` to send, `BUDGET_ALERT_SLACK_WEBHOOK_URL`, and for email
`BUDGET_ALERT_EMAIL_TO` (comma-separated), `BUDGET_ALERT_EMAIL_FROM` and
`RESEND_API_KEY` (Resend). The admin page shows which of these names are set, never
their values. Needs migration 020; without it the tab says "migration 020 not
applied", the inbox has no budget items and the cron sends nothing.

```bash
BASE=https://your-deployment.example.com
CRON_SECRET=replace-with-cron-secret

# ~310 days back covers the gateway history from 2025-12-28.
curl -sS "$BASE/api/cron/vercel-ai-gateway?backfill=true&days=310" \
  -H "Authorization: Bearer $CRON_SECRET" \
  | jq '{success, result: {status: .result.status, records_stored: .result.records_stored, key_sync: .result.key_sync}}'
```

Then refresh the rollups (`/admin` → Refresh, or wait for the 15-minute
refresh-aggregates cron) and assign the keys listed under "Unassigned gateway keys"
on `/admin/org`. "API keys by project" there shows every key under its OpenAI project,
Anthropic workspace or Vercel project.

What a re-pull does to existing rows (`storeRecords()` in `frontend/lib/collectors/runner.ts`):

- Every `api_automated` row for that provider at a bucket timestamp the provider
  returned is deleted, then the new rows are inserted. Old org-level rows (Anthropic
  `model 'unknown'`, no `metadata.attribution`) at the same midnight-UTC bucket are
  **replaced**, not added to, so running the same range twice gives the same rows and
  the same `SUM(cost_usd)`.
- Days inside the range that the provider returns **no** buckets for are **left alone**:
  their existing rows stay. An empty response is not treated as "zero spend". Check the
  `days` list for zero-record days if you expected data there.
- Manual and CSV rows (any other `collection_method`) are never touched.
- Everything is fetched first; if any request in the chunk fails, nothing is deleted or
  inserted and the response has `status: "error"`. Rows the API returns outside the
  requested range are dropped rather than stored.

## Deployment

Deployed as a single Vercel project (root directory `frontend`). The cron schedule in
`frontend/vercel.json` runs each provider's collector daily (staggered ~08:00 UTC),
refreshes the daily aggregates every 15 minutes, and runs the forecast daily. Provider
keys and `CRON_SECRET` live as environment variables on the Vercel project.

## License

Internal Liatrio project — not licensed for external use.
