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
  count). Editable from the admin area.
- 🗂️ **Tools table** — per-tool spend, description, a link to the provider's billing
  console, and a "Last updated" timestamp.
- 🔁 **Automated daily collection** — Vercel Cron triggers in-process TypeScript
  collectors; idempotent (delete-then-insert per day) so re-runs never double-count.
- 🛠️ **Admin area** — trigger a manual pull, add tools, record manual/seat-based monthly
  entries, edit the forecast headcount, and force a dashboard refresh.
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
| **Vercel** | Billing charges (FOCUS) | infra/seats |
| **Vercel AI Gateway** | Custom Reporting API | separate from Vercel billing |
| **Apify** | Monthly usage API | account-scoped token |
| **Windsurf** | Seat subscription (quota plan) | usage from CascadeAnalytics |
| **ChatGPT / Lovable / other** | Manual entry / CSV import | no usable cost API |

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
- **Any authenticated `@liatrio.com` user can reach the `/admin` area** (configurable
  via the `ADMIN_DOMAINS` env var; an explicit `ADMIN_EMAILS` allowlist is also honored).
- The dashboard data is shared — all authenticated users see the same org-wide spend.

## Project structure

```
ai-cost-dashboard/
├── frontend/                 # The application (Next.js, deployed to Vercel)
│   ├── app/                  # App Router pages + API routes (incl. /api/cron/*)
│   ├── components/           # Dashboard, charts, admin, and UI components
│   ├── lib/
│   │   ├── collectors/       # Per-provider TypeScript collectors (+ tests)
│   │   ├── collection.ts     # Cron auth + collector dispatch
│   │   └── supabase/         # Browser/server/admin Supabase clients
│   └── vercel.json           # Cron schedule
└── database/                 # SQL migrations + schema notes (see database/README.md)
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
`VERCEL_TOKEN`, `AI_GATEWAY_API_KEY`, `APIFY_TOKEN`), and optionally `ADMIN_DOMAINS`.
Set `NEXT_PUBLIC_SKIP_AUTH=true` to bypass auth in local dev.

```bash
npm test            # unit tests (collectors, components)
npm run test:e2e    # Playwright end-to-end tests
npm run build       # production build
```

## Deployment

Deployed as a single Vercel project (root directory `frontend`). The cron schedule in
`frontend/vercel.json` runs each provider's collector daily (staggered ~08:00 UTC),
refreshes the daily aggregates every 15 minutes, and runs the forecast daily. Provider
keys and `CRON_SECRET` live as environment variables on the Vercel project.

## License

MIT License — see [LICENSE](./LICENSE).
