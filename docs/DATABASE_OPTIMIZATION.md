# Database Optimization Guide

Complete guide for optimizing database performance in the AI Cost Dashboard.

## Overview

This guide covers:
- TimescaleDB compression and retention policies
- Query optimization strategies
- Connection pooling
- Maintenance procedures
- Performance monitoring

## Prerequisites

- Supabase project with PostgreSQL 15+
- TimescaleDB extension enabled (optional but recommended)
- Access to Supabase SQL Editor or psql

## TimescaleDB Setup (Recommended)

TimescaleDB provides significant performance benefits for time-series data:

### Enable Extension

```sql
-- Run in Supabase SQL Editor
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
```

### Verify Installation

```sql
SELECT default_version, installed_version
FROM pg_available_extensions
WHERE name = 'timescaledb';
```

## Compression Policies

Compression reduces storage costs and can improve query performance for older data.

### Apply Compression

Run the compression script:

```bash
# In Supabase SQL Editor
-- Copy contents of database/maintenance/001_enable_compression.sql
-- Run the script
```

**What it does:**
- Enables compression on cost_records (data older than 7 days)
- Creates hourly aggregates with continuous updates
- Sets retention policies (1 year raw, 2 years hourly, forever daily)
- Adds optimized indexes

### Compression Benefits

- **Storage reduction**: 10-20x compression on time-series data
- **Query performance**: Compressed data can be faster to scan
- **Cost savings**: Reduced database storage costs

## Retention Policies

Automatic data retention keeps database size manageable.

### Current Policies

| Data Type | Retention | Compression | Purpose |
|-----------|-----------|-------------|---------|
| Raw records | 1 year | After 7 days | Detailed analysis |
| Hourly aggregates | 2 years | After 30 days | Trend analysis |
| Daily aggregates | Forever | Not needed | Historical reports |

### Customize Retention

```sql
-- Change raw data retention to 6 months
SELECT remove_retention_policy('cost_records');
SELECT add_retention_policy('cost_records', INTERVAL '6 months');

-- Change hourly retention to 1 year
SELECT remove_retention_policy('cost_records_hourly');
SELECT add_retention_policy('cost_records_hourly', INTERVAL '1 year');
```

## Query Optimization

### Use Optimized Functions

Instead of complex queries, use the pre-built functions:

```sql
-- Get user spending summary
SELECT * FROM get_user_spending_summary('user-uuid', 30);

-- Get daily cost trend with provider breakdown
SELECT * FROM get_daily_cost_trend('user-uuid', 30);
```

### Query Performance Tips

1. **Use indexes wisely:**
   ```sql
   -- Good: Uses index
   SELECT * FROM cost_records
   WHERE user_id = ? AND timestamp > NOW() - INTERVAL '30 days';

   -- Bad: No index on function result
   SELECT * FROM cost_records
   WHERE DATE(timestamp) = '2026-02-11';
   ```

2. **Use aggregates for trends:**
   ```sql
   -- Fast: Uses daily aggregates
   SELECT date, total_cost_usd
   FROM cost_records_daily
   WHERE user_id = ?;

   -- Slow: Scans raw data
   SELECT DATE(timestamp), SUM(cost_usd)
   FROM cost_records
   WHERE user_id = ?
   GROUP BY DATE(timestamp);
   ```

3. **Limit result sets:**
   ```sql
   -- Always use LIMIT for pagination
   SELECT * FROM cost_records
   WHERE user_id = ?
   ORDER BY timestamp DESC
   LIMIT 100 OFFSET 0;
   ```

### Analyze Query Performance

```sql
-- Check query plan
EXPLAIN ANALYZE
SELECT * FROM cost_records
WHERE user_id = ? AND timestamp > NOW() - INTERVAL '7 days';

-- View slow queries
SELECT * FROM slow_queries;
```

## Connection Pooling

### Supabase Connection Pooler

Supabase provides built-in connection pooling:

1. **Session Mode** (default):
   - Connection string: `postgresql://...@aws-0-us-west-1.pooler.supabase.com:5432/postgres`
   - Best for: Long-running queries, transactions
   - Max connections: Based on plan

2. **Transaction Mode**:
   - Connection string: `postgresql://...@aws-0-us-west-1.pooler.supabase.com:6543/postgres`
   - Best for: Serverless, short queries
   - Higher connection limits

### Backend Configuration

Update FastAPI to use connection pooling:

```python
# In app/utils/supabase_client.py
from supabase import create_client, Client

# Use pooler URL for better performance
supabase_url = os.getenv("SUPABASE_URL")  # Use pooler URL
supabase = create_client(supabase_url, service_key)
```

### Recommended Settings

```bash
# Environment variables
SUPABASE_URL=https://xxx.pooler.supabase.com  # Use pooler
SUPABASE_MAX_CONNECTIONS=10  # Per instance
```

## Performance Monitoring

### Built-in Views

```sql
-- Check table sizes
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check index usage
SELECT
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan DESC;

-- Check slow queries
SELECT * FROM slow_queries LIMIT 10;
```

### Supabase Dashboard

Monitor in Supabase Dashboard:
1. Go to Database → Performance
2. View:
   - Query performance
   - Connection stats
   - Table sizes
   - Index usage

### Set Up Alerts

Configure alerts in Supabase:
1. Go to Settings → Alerts
2. Add alerts for:
   - High CPU usage (> 80%)
   - High memory usage (> 80%)
   - Slow queries (> 1s)
   - Connection pool exhaustion

## Maintenance Schedule

### Daily (Automatic)

- Continuous aggregates refresh (every 15 minutes)
- Auto-vacuum on modified tables
- Statistics updates

### Weekly (Recommended)

```sql
-- Update statistics
ANALYZE cost_records;
ANALYZE cost_records_daily;
ANALYZE forecast_results;

-- Check for bloat
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_table_size(schemaname||'.'||tablename)) AS size,
    round(100 * pg_table_size(schemaname||'.'||tablename) /
          pg_database_size(current_database())) AS percentage
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_table_size(schemaname||'.'||tablename) DESC;
```

### Monthly (Recommended)

```sql
-- Run optimization script
-- Copy and run: database/maintenance/002_optimize_queries.sql

-- Reindex tables (during off-peak hours)
REINDEX TABLE CONCURRENTLY cost_records;
REINDEX TABLE CONCURRENTLY cost_records_daily;

-- Vacuum full (if needed, very slow)
-- VACUUM FULL cost_records;  -- Only if necessary
```

## Performance Benchmarks

### Expected Query Times

| Query Type | Records | Expected Time | Notes |
|------------|---------|---------------|-------|
| User summary | 30 days | < 50ms | Uses function |
| Daily trend | 30 days | < 100ms | Uses daily view |
| Raw records | 1000 | < 200ms | With pagination |
| Forecasts | 30 days | < 500ms | Expensive ML |

### Optimization Targets

- 95% of queries < 200ms
- 99% of queries < 1s
- No queries > 5s

## Troubleshooting

### Query Too Slow

1. **Check query plan:**
   ```sql
   EXPLAIN ANALYZE your_query;
   ```

2. **Look for:**
   - Seq Scan (should be Index Scan)
   - High cost numbers
   - Missing indexes

3. **Solutions:**
   - Add appropriate index
   - Use aggregated views
   - Add WHERE clauses to filter data

### Table Bloat

1. **Check bloat:**
   ```sql
   SELECT * FROM pgstattuple('cost_records');
   ```

2. **Fix bloat:**
   ```sql
   -- Light vacuum (safe)
   VACUUM ANALYZE cost_records;

   -- Heavy vacuum (locks table)
   VACUUM FULL cost_records;  -- Use with caution
   ```

### Connection Pool Exhausted

1. **Check connections:**
   ```sql
   SELECT count(*) FROM pg_stat_activity;
   ```

2. **Solutions:**
   - Use connection pooler URL
   - Reduce max_connections per instance
   - Implement request queuing
   - Scale up database plan

### Slow Aggregates

1. **Check refresh policy:**
   ```sql
   SELECT * FROM timescaledb_information.continuous_aggregates;
   ```

2. **Adjust refresh interval:**
   ```sql
   -- Refresh less frequently if needed
   SELECT remove_continuous_aggregate_policy('cost_records_hourly');
   SELECT add_continuous_aggregate_policy('cost_records_hourly',
       start_offset => INTERVAL '1 day',
       end_offset => INTERVAL '1 hour',
       schedule_interval => INTERVAL '30 minutes');
   ```

## Cost Optimization

### Storage Costs

- **Without compression**: ~$0.125/GB/month
- **With compression**: ~$0.010/GB/month (10x savings)
- **Retention policies**: Automatic cleanup saves storage

### Compute Costs

- Optimize queries to use less CPU
- Use connection pooling to reduce overhead
- Use aggregates instead of raw data queries

### Example Savings

For 1M records/month:
- **Raw storage**: ~500MB = $0.0625/month
- **With compression**: ~50MB = $0.00625/month
- **Savings**: $0.05625/month per million records

## Best Practices

1. **Always use indexes** for WHERE clauses
2. **Use aggregates** for trend queries
3. **Enable compression** for cost savings
4. **Set retention policies** to manage growth
5. **Monitor regularly** via Supabase dashboard
6. **Use connection pooling** for serverless
7. **Analyze queries** before optimizing
8. **Test in staging** before production
9. **Schedule maintenance** during off-peak
10. **Document changes** for team

## Additional Resources

- [TimescaleDB Documentation](https://docs.timescale.com/)
- [PostgreSQL Performance Tips](https://wiki.postgresql.org/wiki/Performance_Optimization)
- [Supabase Performance Guide](https://supabase.com/docs/guides/database/performance)

---

**Last Updated**: 2026-02-11
**Version**: 1.0.0
