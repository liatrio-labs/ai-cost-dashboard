# MCP server (read-only spend data)

The AI Cost Dashboard hosts a remote [MCP](https://modelcontextprotocol.io) server so a
Liatrian can point Claude, Cursor, Claude Code or any MCP client at the same data the
dashboard is built from and build their own views: org totals, their own spend, a
department or team, tools and providers, API keys, Cursor billing-cycle on-demand and
seat assignments.

**URL:** `https://ai-cost.liatr.io/api/mcp`

**Sign-in:** Google only, and only `@liatrio.com` accounts. The server checks the
signed-in account itself after Google returns (Google's `hd=liatrio.com` is only a hint):
the account must be a Google identity whose email is exactly `someone@liatrio.com`.
Anything else is refused, and requests without a valid token get `401` with a
`WWW-Authenticate` challenge pointing at the OAuth metadata.

## Connect

Cursor (`~/.cursor/mcp.json`) or Claude Desktop / any client that takes a URL:

```json
{
  "mcpServers": {
    "ai-cost": { "url": "https://ai-cost.liatr.io/api/mcp" }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http ai-cost https://ai-cost.liatr.io/api/mcp
```

Claude.ai: Settings, Connectors, Add custom connector, URL `https://ai-cost.liatr.io/api/mcp`.

The first call opens a browser for Google sign-in. Pick your `@liatrio.com` account;
the client then holds its own token and refreshes it. Signing in to the MCP server does
not touch your browser's dashboard session.

## Tools

All tools are read-only. There is no collection, backfill, seat, rate, invoice-override,
admin or secret tool. Every tool takes an optional period (`month` as `YYYY-MM`, or
`start`/`end` as `YYYY-MM-DD`; default the current month) and, where it makes sense,
filters: `department`, `team` (id or name), `person` (id, `@liatrio.com` email or display
name), `key` (API key id) and `provider` (slug such as `cursor`, `anthropic`, `openai`).

| Tool | Returns |
| --- | --- |
| `get_monthly_headline` | Total, Fixed / subscription vs Variable / usage, change vs previous period, projection |
| `get_spend_by_tool` | Spend per provider with product splits (Cursor: Grok Bot, Bugbot, Agent/Chat, Seats; Claude.ai: Claude Code, Chat, Other), Cursor seats vs calendar-month on-demand, seat/license totals |
| `get_spend_by_person` | Spend per person (People table), with Unassigned and Cursor automation rows |
| `get_person_spend` | One person's total, Fixed vs Variable, provider/model detail, product splits. Defaults to you |
| `get_spend_by_department` | Spend per department |
| `get_spend_by_team` | Spend per team, optionally within a department |
| `get_api_key_spend` | Spend per API key (name, owner, team; never the secret). $0 keys hidden unless `include_zero` |
| `get_cursor_billing_cycle` | Cursor on-demand for the current billing cycle (from `/teams/spend` snapshots) and earlier cycles |
| `get_seat_assignments` | Who holds which Cursor seat type (and rate) for the 20th-to-20th cycle, and per-person seats of tools such as Claude Ultra and ChatGPT |
| `list_org_directory` | Department, team and people ids/names for filters, and which person you are |

### Spend rules (same as the dashboard)

The tools call the same loaders as `/api/dashboard`, `/api/dashboard/breakdown` and
`/api/dashboard/cursor-cycle` (`frontend/lib/dashboard-service.ts`), so numbers match
the UI exactly.

- **Fixed / subscription** is seats, licenses and flat bills. **Variable / usage** is
  metered on-demand only.
- Cursor included-in-business usage comes with the seat and is stored at $0, so it never
  shows as extra cost.
- Cursor products: Grok Bot = `grok-bot-*`, Bugbot = `github_bugbot`, Seats = seat fees,
  Agent/Chat = everything else (including `grok-4.7-*` and `cursor-grok-*`).
- Cursor billing-cycle on-demand is a separate measure. Never add it to calendar-month
  usage or to seat fees.

### Access

A signed-in `@liatrio.com` user reads exactly what the web dashboard shows them: reads
run as that user against Supabase with the public anon key and their own session, so
row-level security applies as in the browser. No service-role key is used for spend data.

## How it works

`/api/mcp` is a stateless Streamable HTTP endpoint (JSON responses, no SSE). OAuth 2.1
follows the MCP authorization spec, modeled on Pulse (`pulse.liatr.io/api/mcp`):

- `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-authorization-server` (metadata)
- `/api/oauth/register` (dynamic client registration; public clients, PKCE S256)
- `/api/oauth/authorize` starts the dashboard's existing Supabase Google sign-in
- `/api/oauth/callback` checks the `@liatrio.com` Google identity and returns a code
- `/api/oauth/token` (authorization code and refresh token grants)

No database tables: client ids, codes and tokens are AES-256-GCM sealed blobs that carry
the caller's own Supabase session. Codes are single-use in effect because redeeming one
rotates the Supabase refresh token inside it. Code: `frontend/lib/mcp/`.

## Deployment setup

1. Set `MCP_OAUTH_SECRET` (random, at least 32 characters, e.g. `openssl rand -base64 48`).
   Without it the MCP endpoints answer 503 / 401 and nothing else changes. Rotating it signs
   everyone out of MCP clients (they re-register and sign in again).
2. Set `MCP_PUBLIC_URL=https://ai-cost.liatr.io` so tokens are bound to the public URL.
3. In Supabase, Authentication, URL Configuration, add
   `https://ai-cost.liatr.io/api/oauth/callback` to the Redirect URLs (skip if a wildcard
   already covers it). The Google provider itself is unchanged.
