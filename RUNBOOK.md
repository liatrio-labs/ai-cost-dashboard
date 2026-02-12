# Operations Runbook

Quick reference guide for common operational tasks and incident response.

## Quick Links

- [Health Check](#health-check)
- [Common Incidents](#common-incidents)
- [Deployment](#deployment)
- [Database Operations](#database-operations)
- [Emergency Procedures](#emergency-procedures)

## Health Check

### Check Service Status

```bash
# Backend health
curl https://your-api.com/health/detailed

# Expected: {"status": "healthy", ...}
```

### Check Individual Components

```bash
# Database only
curl https://your-api.com/health/db

# Scheduler only
curl https://your-api.com/health/scheduler

# Metrics
curl https://your-api.com/metrics
```

## Common Incidents

### Incident 1: Service Not Responding

**Symptoms:**
- Health check times out or returns 5xx errors
- Users cannot access dashboard

**Diagnosis:**
```bash
# Check if service is running
ps aux | grep uvicorn

# Check recent logs
tail -n 100 logs/error.log

# Check system resources
top
df -h
```

**Resolution:**
1. Restart the service:
   ```bash
   systemctl restart ai-cost-dashboard  # Or your process manager
   ```

2. If still failing, check:
   - Environment variables loaded correctly
   - Database connection works
   - No port conflicts

3. Monitor logs during restart:
   ```bash
   tail -f logs/app.log
   ```

### Incident 2: Database Connection Failed

**Symptoms:**
- `/health/db` returns 503
- Errors mentioning "Database connection failed"

**Diagnosis:**
```bash
# Check Supabase status
curl https://status.supabase.com/api/v2/status.json

# Verify connection from server
curl -I https://your-project.supabase.co
```

**Resolution:**
1. Check Supabase dashboard for issues
2. Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are correct
3. Check network connectivity to Supabase
4. Restart service if credentials were updated

### Incident 3: High Error Rate

**Symptoms:**
- Sentry shows spike in errors
- Multiple 500 errors in logs

**Diagnosis:**
```bash
# Check recent errors
grep "ERROR" logs/error.log | tail -n 50

# Check memory and CPU
top
free -h
```

**Resolution:**
1. Identify error pattern in Sentry
2. Check if specific endpoint is failing
3. Review recent code deployments
4. Rollback if necessary
5. Scale resources if system overloaded

### Incident 4: Scheduler Jobs Not Running

**Symptoms:**
- `/health/scheduler` shows jobs not executing
- No recent data collection

**Diagnosis:**
```bash
# Check scheduler status
curl https://your-api.com/health/scheduler | jq '.job_history'

# Check scheduler logs
grep "scheduler" logs/app.log
```

**Resolution:**
1. Check if scheduler is running in health endpoint
2. Verify cron expressions are valid
3. Check API credentials are active
4. Manually trigger job to test:
   ```bash
   curl -X POST https://your-api.com/api/scheduler/trigger/anthropic_collection
   ```

### Incident 5: Prophet Forecasting Fails

**Symptoms:**
- `/api/forecast/generate` returns 422 or 500
- Errors about insufficient data

**Diagnosis:**
```bash
# Check forecast endpoint health
curl https://your-api.com/api/forecast/health

# Check recent forecast errors
grep "forecast" logs/error.log
```

**Resolution:**
1. **If "insufficient data" (422)**:
   - User needs at least 30 days of cost records
   - Check database for user's records

2. **If internal error (500)**:
   - Check memory usage (Prophet models are large)
   - Verify Prophet package installed correctly
   - Check for data quality issues (NaN, infinite values)

### Incident 6: Memory Leak

**Symptoms:**
- Memory usage continuously increasing
- Eventually hits OOM (Out of Memory)

**Diagnosis:**
```bash
# Monitor memory over time
watch -n 5 'free -h'

# Check which process using memory
ps aux --sort=-%mem | head -n 10

# Check for Prophet model caching issues
grep "CostForecaster" logs/app.log
```

**Resolution:**
1. Restart service immediately if critical
2. Review recent code for memory leaks
3. Check Prophet model caching
4. Consider reducing `uncertainty_samples` in Prophet config
5. Scale up server if needed

## Deployment

### Backend Deployment

```bash
# 1. Pull latest code
cd /path/to/ai-cost-dashboard/python-service
git pull origin main

# 2. Activate virtual environment
source venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run database migrations (if any)
# (Migration process depends on your setup)

# 5. Restart service
systemctl restart ai-cost-dashboard

# 6. Verify deployment
curl https://your-api.com/health/detailed

# 7. Monitor logs
tail -f logs/app.log
```

### Frontend Deployment

Frontend deploys automatically via Vercel on git push to main branch.

**Manual deployment:**
```bash
cd /path/to/ai-cost-dashboard/frontend
vercel --prod
```

**Verify deployment:**
```bash
curl https://your-frontend.vercel.app
```

## Database Operations

### Query Performance

**Find slow queries:**
```bash
# Check Supabase dashboard > Performance tab
# Look for queries with >1s execution time
```

**Optimize slow queries:**
1. Add appropriate indexes
2. Use materialized views for complex aggregations
3. Limit result sets with LIMIT clauses

### Backup and Restore

**Automated backups:**
- Supabase performs automatic daily backups
- Retention: 7 days on free tier, 30+ days on paid tiers

**Manual backup:**
```bash
# Export via Supabase dashboard > Database > Backups
# Or use pg_dump if direct access available
```

### Refresh Materialized Views

```bash
# Trigger aggregate refresh manually
curl -X POST https://your-api.com/api/scheduler/trigger/aggregate_refresh
```

## Emergency Procedures

### Complete Service Outage

**Response Time: Immediate**

1. **Assess Scope**
   ```bash
   curl https://your-api.com/health
   curl https://your-frontend.vercel.app
   ```

2. **Check External Dependencies**
   - Supabase: https://status.supabase.com
   - Vercel: https://www.vercel-status.com
   - Anthropic: https://status.anthropic.com
   - OpenAI: https://status.openai.com

3. **Check Logs**
   ```bash
   tail -n 500 logs/error.log
   ```

4. **Restart Services**
   ```bash
   systemctl restart ai-cost-dashboard
   ```

5. **Notify Stakeholders**
   - Update status page (if available)
   - Send notification to users

### Data Loss Incident

**Response Time: Immediate**

1. **Stop All Writes**
   - Disable scheduler
   - Take service offline if necessary

2. **Assess Damage**
   - Check database for missing records
   - Check Supabase backup status

3. **Restore from Backup**
   - Use Supabase dashboard to restore
   - Verify data integrity after restore

4. **Investigate Root Cause**
   - Check logs for deletion events
   - Review recent code changes
   - Check audit logs

### Security Breach

**Response Time: Immediate**

1. **Contain**
   - Rotate all API keys immediately
   - Revoke compromised credentials
   - Block suspicious IP addresses

2. **Assess**
   - Check audit logs for unauthorized access
   - Identify compromised accounts
   - Determine scope of breach

3. **Notify**
   - Inform affected users
   - Report to authorities if required
   - Document incident

4. **Remediate**
   - Fix security vulnerability
   - Deploy patches
   - Implement additional security measures

## Maintenance Tasks

### Weekly

```bash
# 1. Check log file sizes
du -sh logs/*

# 2. Review error rates in Sentry

# 3. Check system resources
df -h
free -h

# 4. Review scheduler job history
curl https://your-api.com/health/scheduler | jq '.job_history'
```

### Monthly

```bash
# 1. Update dependencies
pip list --outdated

# 2. Review and archive old logs
find logs/ -name "*.log.*" -mtime +30 -delete

# 3. Check database performance
# Review slow queries in Supabase dashboard

# 4. Test disaster recovery
# Verify backups can be restored
```

### Quarterly

```bash
# 1. Security audit
# Review access logs, rotate secrets

# 2. Capacity planning
# Analyze growth trends, plan scaling

# 3. Update documentation
# Ensure runbook and monitoring docs are current
```

## Rollback Procedure

### Backend Rollback

```bash
# 1. Identify last known good commit
git log --oneline

# 2. Checkout previous version
git checkout <commit-hash>

# 3. Restart service
systemctl restart ai-cost-dashboard

# 4. Verify
curl https://your-api.com/health/detailed
```

### Frontend Rollback

```bash
# Via Vercel dashboard:
# 1. Go to Deployments tab
# 2. Find previous successful deployment
# 3. Click "Promote to Production"

# Or via CLI:
vercel rollback
```

## Contact Information

### On-Call Rotation

| Role | Primary | Secondary |
|------|---------|-----------|
| Backend | TBD | TBD |
| Frontend | TBD | TBD |
| Database | TBD | TBD |

### Escalation Path

1. On-call engineer (immediate)
2. Team lead (if >30 min)
3. Engineering manager (if >2 hours or critical)

### External Contacts

- Supabase Support: support@supabase.io
- Vercel Support: support@vercel.com
- Sentry Support: support@sentry.io

## Useful Commands

### Logs

```bash
# Tail all logs
tail -f logs/app.log

# Filter errors only
grep "ERROR" logs/app.log

# Filter by user
grep "user_id.*uuid-here" logs/app.log

# Count errors in last hour
grep "ERROR" logs/app.log | tail -n 1000 | wc -l

# Pretty print JSON logs
tail logs/app.log | jq '.'
```

### System Monitoring

```bash
# CPU and memory
top

# Disk usage
df -h
du -sh /path/to/logs/*

# Network connections
netstat -tlnp

# Process info
ps aux | grep uvicorn
```

### Database

```bash
# Check connection
curl https://your-api.com/health/db

# Get metrics
curl https://your-api.com/metrics | jq '.application'
```

## Version Information

- **Runbook Version**: 1.0
- **Last Updated**: 2026-02-11
- **Next Review**: 2026-05-11
