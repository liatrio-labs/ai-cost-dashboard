# Database Schema Documentation

This directory contains the Supabase PostgreSQL database schema and migration files for the AI Cost Dashboard application.

## Overview

The database is designed to efficiently store and query AI API usage costs across multiple providers with:
- **Time-series optimization** through table partitioning
- **Row-Level Security (RLS)** for multi-user data isolation
- **Materialized views** for fast dashboard queries
- **Comprehensive indexing** for optimal query performance
- **Encrypted credential storage** for API keys

## Architecture

### Database Provider
- **Platform**: Supabase (Managed PostgreSQL)
- **Version**: PostgreSQL 15+
- **Extensions**: uuid-ossp, pgcrypto
- **Authentication**: Supabase Auth (integrated with RLS)

### Key Design Decisions

1. **Table Partitioning**: The `cost_records` table uses PostgreSQL declarative partitioning by month to optimize time-series queries
2. **Materialized Views**: Pre-aggregated daily costs in `cost_records_daily` for fast dashboard rendering
3. **RLS Policies**: All user data is protected with Row-Level Security ensuring users only see their own data
4. **Encryption**: API credentials are encrypted at application layer (AES-256) before storage
5. **Denormalization**: Strategic denormalization (e.g., model_name) for query performance

## Database Schema

### Core Tables

#### 1. `providers`
Stores AI service provider information.

```sql
- id (UUID, PK)
- name (VARCHAR, UNIQUE) - e.g., 'anthropic', 'openai'
- display_name (VARCHAR) - Human-readable name
- api_base_url (VARCHAR) - Base API endpoint
- is_active (BOOLEAN)
- metadata (JSONB) - Provider-specific config
```

**Seeded Providers**:
- `anthropic` - Anthropic Claude API
- `claude-desktop` - Claude.ai manual tracking
- `openai` - OpenAI API
- `chatgpt` - ChatGPT manual entry

#### 2. `api_credentials`
Stores encrypted API keys and credentials per user.

```sql
- id (UUID, PK)
- user_id (UUID, FK → auth.users) - Owner
- provider_id (UUID, FK → providers)
- credential_name (VARCHAR) - User-defined label
- encrypted_api_key (TEXT) - AES-256 encrypted key
- encryption_key_id (VARCHAR) - Key version for rotation
- is_active (BOOLEAN)
- validation_status (VARCHAR) - 'valid', 'invalid', 'pending'
- metadata (JSONB)
```

**Security**:
- Protected by RLS (users see only their own credentials)
- Keys encrypted before insertion using application-layer encryption
- Supports key rotation via `encryption_key_id`

#### 3. `cost_records` (PARTITIONED)
Main time-series table storing individual cost entries.

```sql
- id (UUID)
- user_id (UUID, FK → auth.users)
- provider_id (UUID, FK → providers)
- timestamp (TIMESTAMPTZ) - Time of usage
- model_name (VARCHAR) - e.g., 'gpt-4', 'claude-3-opus'
- cost_usd (NUMERIC(12,6)) - Cost in USD
- tokens_used (BIGINT)
- input_tokens (BIGINT)
- output_tokens (BIGINT)
- request_count (BIGINT)
- collection_method (VARCHAR) - 'api_automated', 'manual_entry', 'csv_import'
- metadata (JSONB)
- PK: (id, timestamp)
```

**Partitioning Strategy**:
- Partitioned by `timestamp` using RANGE partitioning
- Monthly partitions for 2026 (cost_records_2026_01 through cost_records_2026_12)
- Quarterly partitions for boundary years
- New partitions created automatically or via `create_monthly_partition()` function

**Benefits**:
- Faster queries on time ranges (partition pruning)
- Easier data archival and deletion
- Improved vacuum and analyze performance

#### 4. `cost_records_daily` (MATERIALIZED VIEW)
Pre-aggregated daily costs for dashboard performance.

```sql
- user_id (UUID)
- provider_id (UUID)
- date (DATE)
- model_name (VARCHAR)
- total_cost_usd (NUMERIC)
- total_tokens (BIGINT)
- total_input_tokens (BIGINT)
- total_output_tokens (BIGINT)
- total_requests (BIGINT)
- record_count (BIGINT)
```

**Refresh Strategy**:
- Refreshed nightly via scheduled job
- Uses `REFRESH MATERIALIZED VIEW CONCURRENTLY` for non-blocking updates
- Called via `refresh_cost_records_daily()` function

#### 5. `forecast_results`
Stores ML-generated cost predictions from Prophet model.

```sql
- id (UUID, PK)
- user_id (UUID, FK → auth.users)
- provider_id (UUID, FK → providers, nullable)
- model_name (VARCHAR, nullable)
- forecast_date (DATE) - Future date being predicted
- predicted_cost_usd (NUMERIC(12,6))
- lower_bound_80/upper_bound_80 (NUMERIC) - 80% confidence interval
- lower_bound_95/upper_bound_95 (NUMERIC) - 95% confidence interval
- confidence_score (NUMERIC(3,2)) - 0.00 to 1.00
- model_version (VARCHAR)
- training_data_start/end (DATE)
- training_record_count (INTEGER)
- metadata (JSONB) - Model parameters
```

**Usage**:
- Stores 30-day predictions per user/provider/model
- Multiple predictions stored for historical comparison
- Confidence intervals for uncertainty visualization

#### 6. `user_preferences`
User-specific dashboard settings.

```sql
- user_id (UUID, PK, FK → auth.users)
- currency (VARCHAR) - Default 'USD'
- timezone (VARCHAR) - Default 'UTC'
- theme (VARCHAR) - 'light', 'dark', 'system'
- default_date_range (VARCHAR) - '7d', '30d', '90d', 'all'
- email_notifications (BOOLEAN)
- forecast_enabled (BOOLEAN)
- metadata (JSONB)
```

**Auto-initialization**:
- Automatically created when user signs up (via trigger)

#### 7. Org structure (migration 010)
Departments, teams and people that AI spend is attributed to. `people` are not
`auth.users`: most people never sign in.

```sql
departments       (id, name UNIQUE, description, created_at, updated_at)
teams             (id, name, department_id → departments NULL, timestamps)
                  UNIQUE NULLS NOT DISTINCT (department_id, name)
people            (id, email UNIQUE lower-cased, display_name, team_id → teams NULL,
                   active, timestamps)
person_identities (id, person_id → people, provider_id → providers, external_id,
                   timestamps) UNIQUE (provider_id, external_id)
org_api_keys      (id, provider_id → providers, external_key_id, name,
                   owner_person_id → people NULL, team_id → teams NULL, timestamps)
                  UNIQUE (provider_id, external_key_id)
```

`person_identities.external_id` is a provider user/actor id, or an email the
provider reports that differs from the person's `people.email` (store it
lower-cased). `org_api_keys` holds key metadata only, never secrets; it's
separate from the legacy `api_credentials` table.

**Access**: RLS on; authenticated users can `SELECT`, writes go through the
service role (admin routes), as in migration 003.

#### 8. `cost_records_daily_attributed` (MATERIALIZED VIEW, migration 010)
`cost_records_daily` plus attribution, resolved from
`cost_records.metadata.attribution` (contract in epic #4).

```sql
- date, provider_id, model_name
- person_id, org_api_key_id, team_id, department_id   -- NULL = Unassigned
- project_id, workspace_id                            -- from the attribution
- granularity  -- 'person' | 'api_key' | 'project' | 'workspace' | 'org'
- total_cost_usd, total_tokens, total_input_tokens, total_output_tokens,
  total_requests, record_count
```

**Attribution precedence** (identical in `frontend/lib/org/attribution.ts`):

1. Person: `person_email` = `people.email` (case-insensitive); else
   `(provider, person_external_id)` in `person_identities`; else
   `(provider, person_email)` in `person_identities.external_id`; else the API
   key's `owner_person_id`; else none.
2. Team: the API key's `team_id`; else the person's `team_id`; else Unassigned.
3. Department: the team's `department_id`; else Unassigned.

Rows without `attribution` (everything written before #6) get granularity
`org` and land in Unassigned, so for every date the view's totals equal
`cost_records_daily`. Membership is **current-state**: reassigning a person,
key or team moves their historical spend on the next refresh.

The unique index uses `NULLS NOT DISTINCT` (PostgreSQL 15+) so `REFRESH ...
CONCURRENTLY` works with NULL (Unassigned) keys. `anon` has no access.

## Indexes

### Performance-Critical Indexes

```sql
-- Cost Records (time-series queries)
cost_records_user_timestamp_idx (user_id, timestamp DESC)
cost_records_provider_timestamp_idx (provider_id, timestamp DESC)
cost_records_timestamp_idx (timestamp DESC)
cost_records_user_provider_idx (user_id, provider_id, timestamp DESC)

-- Daily Aggregation (materialized view)
cost_records_daily_unique_idx (user_id, provider_id, date, model_name) UNIQUE
cost_records_daily_user_date_idx (user_id, date DESC)
cost_records_daily_date_idx (date DESC)

-- Forecasts
forecast_results_user_date_idx (user_id, forecast_date DESC)
forecast_results_provider_date_idx (provider_id, forecast_date DESC)

-- Credentials
api_credentials_user_id_idx (user_id)
api_credentials_active_idx (user_id, is_active) WHERE is_active = true
```

## Row-Level Security (RLS)

All user-specific tables have RLS enabled with policies ensuring users can only access their own data.

### Policy Patterns

**api_credentials, cost_records, forecast_results, user_preferences**:
```sql
-- SELECT: Users can view own records
USING (auth.uid() = user_id)

-- INSERT: Users can create own records
WITH CHECK (auth.uid() = user_id)

-- UPDATE: Users can update own records
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id)

-- DELETE: Users can delete own records
USING (auth.uid() = user_id)
```

### Authentication Integration

- Supabase Auth manages user authentication
- `auth.uid()` function returns current authenticated user
- RLS policies automatically filter queries based on auth context

## Utility Functions

### 1. `refresh_cost_records_daily()`
Refreshes `cost_records_daily` and (since migration 010)
`cost_records_daily_attributed`. Called every 15 minutes by the
`/api/cron/refresh-aggregates` route.
```sql
SELECT refresh_cost_records_daily();
```
**Usage**: Schedule nightly via cron or pg_cron extension

### 2. `get_user_total_spend(user_id, start_date, end_date)`
Calculate total spending for a user in date range.
```sql
SELECT get_user_total_spend(
    '123e4567-e89b-12d3-a456-426614174000'::UUID,
    '2026-01-01'::TIMESTAMPTZ,
    '2026-02-01'::TIMESTAMPTZ
);
```

### 3. `get_top_models_by_spend(user_id, start_date, end_date, limit)`
Get top N models by spending for analysis.
```sql
SELECT * FROM get_top_models_by_spend(
    '123e4567-e89b-12d3-a456-426614174000'::UUID,
    '2026-01-01'::TIMESTAMPTZ,
    '2026-02-01'::TIMESTAMPTZ,
    5
);
```

### 4. `create_monthly_partition(year, month)`
Create new monthly partition for cost_records.
```sql
SELECT create_monthly_partition(2027, 1); -- Creates cost_records_2027_01
```
**Usage**: Run at end of each month to create next month's partition

## Migration Strategy

### Supabase Migration Process

1. **Local Development**:
   ```bash
   # Initialize Supabase project
   supabase init

   # Start local Supabase
   supabase start

   # Create new migration
   supabase migration new migration_name

   # Apply migrations
   supabase db reset
   ```

2. **Production Deployment**:
   ```bash
   # Link to Supabase project
   supabase link --project-ref your-project-ref

   # Push migrations to production
   supabase db push

   # Or apply specific migration
   supabase migration up
   ```

3. **Migration Files**:
   - Located in `/database/migrations/`
   - Numbered sequentially: `001_initial_schema.sql`, `002_add_feature.sql`
   - Each file is idempotent (can be run multiple times safely)
   - Use `IF NOT EXISTS`, `ON CONFLICT`, and conditional logic

### Current Migrations

- **001_initial_schema.sql**: Initial database setup
  - All core tables
  - Indexes and constraints
  - RLS policies
  - Utility functions
  - Seed data (providers)
  - Partitions through 2027 Q2

- **002-009**: providers, shared read access, signup trigger fix,
  app_settings, `providers.last_collected_at`, BIGINT token columns
- **010_org_structure.sql**: departments, teams, people, person_identities,
  org_api_keys, `cost_records_daily_attributed`; refresh function covers both views

### Testing migrations locally

`scripts/test-migrations.sh` starts a throwaway PostgreSQL 15 on a unix socket
in a temp dir, applies `scripts/migration-tests/auth_stub.sql` (roles `anon`,
`authenticated`, `service_role`, `auth.users`, `auth.uid()`), then 001-010,
re-applies 010, seeds `fixtures.sql` and runs `assertions.sql` (precedence
rules, Unassigned, per-date reconciliation with `cost_records_daily`, both
views refreshed by `refresh_cost_records_daily()`, RLS/grants), then re-applies
010 over the data. Server binaries come from `PG_BIN`, an installed
`postgresql-15`, or `FETCH_PG=1` (downloads `@embedded-postgres/linux-x64` 15.x
from npm). Any recent `psql` works as the client.

### Future Migration Guidelines

1. **Always include rollback capability** (create corresponding DOWN migration)
2. **Test locally first** using `supabase db reset`
3. **Use transactions** for multi-statement migrations
4. **Document breaking changes** in migration comments
5. **Create partitions proactively** (3-6 months ahead)

## Maintenance Tasks

### Regular Maintenance

1. **Refresh Materialized View** (Daily)
   ```sql
   SELECT refresh_cost_records_daily();
   ```

2. **Create New Partitions** (Monthly)
   ```sql
   -- Create next month's partition
   SELECT create_monthly_partition(2027, 3);
   ```

3. **Vacuum and Analyze** (Weekly)
   ```sql
   VACUUM ANALYZE cost_records;
   VACUUM ANALYZE cost_records_daily;
   ```

4. **Monitor Table Sizes**
   ```sql
   SELECT
       schemaname,
       tablename,
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
   FROM pg_tables
   WHERE schemaname = 'public'
   ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
   ```

### Archival Strategy

For old partitions (>2 years):
```sql
-- Detach old partition
ALTER TABLE cost_records DETACH PARTITION cost_records_2024_01;

-- Export to cold storage or drop
DROP TABLE cost_records_2024_01;
```

## Performance Optimization

### Query Best Practices

1. **Always include user_id** in WHERE clauses (leverages RLS and indexes)
2. **Use date ranges** to benefit from partition pruning
3. **Query materialized view** for aggregated data instead of raw table
4. **Limit result sets** with appropriate LIMIT clauses
5. **Use EXISTS** instead of COUNT(*) for existence checks

### Example Optimized Queries

**Get user costs for last 30 days**:
```sql
SELECT
    DATE(timestamp) AS date,
    SUM(cost_usd) AS daily_cost
FROM cost_records
WHERE user_id = auth.uid()
    AND timestamp >= NOW() - INTERVAL '30 days'
GROUP BY DATE(timestamp)
ORDER BY date DESC;
```

**Get provider breakdown** (using materialized view):
```sql
SELECT
    p.display_name,
    SUM(crd.total_cost_usd) AS total_cost
FROM cost_records_daily crd
JOIN providers p ON p.id = crd.provider_id
WHERE crd.user_id = auth.uid()
    AND crd.date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY p.display_name
ORDER BY total_cost DESC;
```

## Troubleshooting

### Common Issues

**Issue**: Partition doesn't exist for current month
```sql
-- Solution: Create missing partition
SELECT create_monthly_partition(2027, 4);
```

**Issue**: Materialized view out of date
```sql
-- Solution: Refresh manually
REFRESH MATERIALIZED VIEW CONCURRENTLY cost_records_daily;
```

**Issue**: Slow queries on cost_records
```sql
-- Check if query is using partition pruning
EXPLAIN ANALYZE
SELECT * FROM cost_records
WHERE timestamp >= '2026-02-01'
    AND timestamp < '2026-03-01';

-- Should show only relevant partition in plan
```

**Issue**: RLS policy blocking queries
```sql
-- Verify current user
SELECT auth.uid();

-- Check RLS policies
SELECT * FROM pg_policies WHERE tablename = 'cost_records';

-- Temporarily disable RLS for debugging (superuser only)
ALTER TABLE cost_records DISABLE ROW LEVEL SECURITY;
-- Re-enable after debugging
ALTER TABLE cost_records ENABLE ROW LEVEL SECURITY;
```

## Security Considerations

1. **API Keys**: Never store plaintext API keys
   - Encrypt at application layer before INSERT
   - Use environment variables for encryption keys
   - Implement key rotation via `encryption_key_id`

2. **RLS Bypass**: Never disable RLS in production
   - All queries go through RLS policies
   - Service role key bypasses RLS (use cautiously)

3. **SQL Injection**: Always use parameterized queries
   - Frontend uses Supabase client (automatic protection)
   - Backend uses SQLAlchemy with parameterized queries

4. **Audit Logging**: Consider adding audit triggers
   - Log sensitive operations (credential changes)
   - Store in separate audit table

## Backup and Recovery

### Supabase Automated Backups
- Supabase provides automatic daily backups
- Point-in-time recovery available on Pro tier
- Backup retention: 7 days (Pro), 30 days (Pro+)

### Manual Backup
```bash
# Export specific tables
supabase db dump -f backup.sql

# Export data only
supabase db dump --data-only -f data_backup.sql

# Restore from backup
psql -d postgres://[connection_string] -f backup.sql
```

## Additional Resources

- [Supabase Documentation](https://supabase.com/docs)
- [PostgreSQL Partitioning Guide](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
- [Materialized Views](https://www.postgresql.org/docs/current/sql-creatematerializedview.html)

## Contact

For database schema questions or migration issues, contact the database team or open an issue in the project repository.
