# Monitoring and Observability Guide

This document describes the monitoring, logging, and observability setup for the AI Cost Dashboard.

## Table of Contents

1. [Overview](#overview)
2. [Logging](#logging)
3. [Error Tracking](#error-tracking)
4. [Health Checks](#health-checks)
5. [Metrics](#metrics)
6. [Alerting](#alerting)
7. [Troubleshooting](#troubleshooting)

## Overview

The AI Cost Dashboard implements comprehensive monitoring across both frontend and backend:

- **Structured Logging**: JSON-formatted logs for easy parsing and analysis
- **Error Tracking**: Sentry integration for real-time error monitoring
- **Health Checks**: Multiple endpoints for service health verification
- **Metrics**: System and application metrics exposed via API
- **Request Logging**: Automatic logging of all HTTP requests with timing

## Logging

### Backend (Python/FastAPI)

#### Configuration

Logging is configured in `/python-service/app/utils/logging_config.py`.

**Environment Variables:**
```bash
LOG_LEVEL=INFO                    # DEBUG, INFO, WARNING, ERROR, CRITICAL
ENVIRONMENT=production            # Auto-enables JSON logging in production
```

#### Log Formats

**Development (Human-readable):**
```
2026-02-11 20:30:45 - app.main - INFO - Starting service [main.py:25]
```

**Production (JSON):**
```json
{
  "timestamp": "2026-02-11T20:30:45Z",
  "level": "INFO",
  "service": "ai-cost-dashboard-backend",
  "environment": "production",
  "module": "main",
  "function": "lifespan",
  "line": 25,
  "message": "Starting service"
}
```

#### Log Files

Logs are written to `/python-service/logs/`:

- `app.log` - All logs (rotates at 10MB, keeps 5 backups)
- `error.log` - Errors only (rotates at 10MB, keeps 10 backups)
- `audit.log` - Security events (rotates daily, keeps 30 days)

#### Request Logging

All HTTP requests are automatically logged with:
- Method and path
- Status code
- Duration in milliseconds
- User ID (if authenticated)
- Errors (if any)

Example:
```json
{
  "method": "POST",
  "path": "/api/forecast/generate",
  "status_code": 201,
  "duration_ms": 245.67,
  "user_id": "uuid-here"
}
```

#### Audit Logging

Security-relevant events are logged to the audit log:

```python
from app.utils.logging_config import log_audit_event

log_audit_event(
    event_type="api_key_creation",
    user_id="user-uuid",
    resource_type="api_key",
    resource_id="key-uuid",
    action="create",
    metadata={"provider": "anthropic"}
)
```

### Frontend (Next.js)

#### Console Logging

Errors are automatically logged to the browser console and sent to Sentry in production.

#### Custom Logging

Use the browser's console API for client-side logging:
```typescript
console.log('Info message');
console.warn('Warning message');
console.error('Error message');
```

## Error Tracking

### Sentry Integration

Both frontend and backend integrate with Sentry for real-time error tracking and alerting.

#### Backend Configuration

**Environment Variables:**
```bash
SENTRY_DSN=https://your-dsn@sentry.io/project-id
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.1      # 10% of transactions
SENTRY_PROFILES_SAMPLE_RATE=0.1    # 10% of transactions
RELEASE_VERSION=1.0.0
```

#### Frontend Configuration

**Environment Variables:**
```bash
NEXT_PUBLIC_SENTRY_DSN=https://your-dsn@sentry.io/project-id
NEXT_PUBLIC_ENVIRONMENT=production
NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=0.1
```

#### Filtered Errors

The following errors are **not** sent to Sentry:
- `HTTPException` (expected API errors)
- `RequestValidationError` (Pydantic validation errors)
- `ResizeObserver loop limit exceeded` (browser quirk)
- `Loading chunk failed` (network issues)

#### Manual Error Capture

**Backend:**
```python
from app.utils.sentry_config import capture_exception, capture_message

try:
    # Your code
    pass
except Exception as e:
    capture_exception(e, context={"user_id": "uuid"})

# Or send a message
capture_message("Something important happened", level="warning")
```

**Frontend:**
```typescript
import * as Sentry from '@sentry/nextjs';

try {
  // Your code
} catch (error) {
  Sentry.captureException(error);
}
```

## Health Checks

### Backend Endpoints

#### `GET /health`
Basic health check - verifies service is running.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-02-11T20:30:45Z",
  "service": "ai-cost-dashboard-backend",
  "version": "1.0.0"
}
```

#### `GET /health/detailed`
Comprehensive health check with all dependencies.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-02-11T20:30:45Z",
  "service": "ai-cost-dashboard-backend",
  "version": "1.0.0",
  "uptime_seconds": 3600.5,
  "uptime_human": "1h 0m 0s",
  "checks": {
    "database": {
      "healthy": true,
      "response_time_ms": 12.34,
      "message": "Database connected"
    },
    "scheduler": {
      "healthy": true,
      "jobs": [
        {
          "id": "anthropic_collection",
          "name": "Anthropic Data Collection",
          "next_run": "2026-02-11T21:05:00Z"
        }
      ],
      "message": "Scheduler running"
    },
    "system": {
      "healthy": true,
      "cpu_percent": 15.2,
      "memory_percent": 45.8,
      "memory_available_mb": 2048.0,
      "disk_percent": 60.5,
      "disk_free_gb": 50.2
    }
  }
}
```

**Status Values:**
- `healthy` - All systems operational
- `degraded` - Non-critical services down (e.g., scheduler)
- `unhealthy` - Critical services down (e.g., database)

#### `GET /health/db`
Database connectivity check only.

**Response:**
```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2026-02-11T20:30:45Z",
  "response_time_ms": 15.67
}
```

#### `GET /health/scheduler`
Scheduler status check.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-02-11T20:30:45Z",
  "running": true,
  "jobs": [...],
  "job_history": {...}
}
```

### Frontend Health Check

The frontend does not expose a dedicated health endpoint. Monitor it using:
- Vercel deployment status
- Sentry error rates
- Uptime monitoring services

## Metrics

### `GET /metrics`
Expose system and application metrics.

**Response:**
```json
{
  "timestamp": "2026-02-11T20:30:45Z",
  "service": "ai-cost-dashboard-backend",
  "system": {
    "cpu_percent": 15.2,
    "memory_percent": 45.8,
    "memory_used_mb": 256.5,
    "threads": 8,
    "open_files": 12
  },
  "application": {
    "cost_records_24h": 1542
  }
}
```

### Metric Collection

These endpoints should be polled by monitoring systems like:
- Prometheus
- Datadog
- New Relic
- Grafana

## Alerting

### Recommended Alerts

#### Critical (Immediate Action Required)

1. **Service Down**
   - Condition: `/health` returns non-200 or times out
   - Action: Check service logs, restart if needed

2. **Database Connection Failed**
   - Condition: `/health/db` returns 503
   - Action: Check Supabase status, verify credentials

3. **High Error Rate**
   - Condition: Sentry reports >10 errors/minute
   - Action: Check error details in Sentry, investigate root cause

#### Warning (Monitor Closely)

1. **High Memory Usage**
   - Condition: `memory_percent > 85%`
   - Action: Monitor for memory leaks, consider scaling

2. **High Response Time**
   - Condition: Average response time > 2 seconds
   - Action: Check database performance, review slow queries

3. **Scheduler Jobs Failing**
   - Condition: Job history shows repeated failures
   - Action: Check job logs, verify API credentials

### Sentry Alerts

Configure Sentry alerts for:
- New error types (first occurrence)
- Error spike (>10x normal rate)
- Performance degradation (p95 response time > 2s)

### Setting Up Alerts

**Sentry:**
1. Go to Project Settings > Alerts
2. Create alert rules based on error frequency and types
3. Configure notification channels (email, Slack, PagerDuty)

**Uptime Monitoring:**
Use services like:
- UptimeRobot (free tier available)
- Pingdom
- StatusCake

Monitor these URLs:
- Backend: `https://your-api.com/health`
- Frontend: `https://your-frontend.vercel.app`

## Troubleshooting

### Common Issues

#### 1. Logs Not Appearing

**Symptom:** No logs in console or files.

**Solutions:**
- Check `LOG_LEVEL` environment variable
- Verify log directory permissions (`logs/` must be writable)
- Check disk space

#### 2. Sentry Not Receiving Errors

**Symptom:** Errors not showing in Sentry dashboard.

**Solutions:**
- Verify `SENTRY_DSN` is set correctly
- Check if error is being filtered (see `beforeSend` in config)
- Verify network connectivity to Sentry
- Check Sentry project settings

#### 3. Health Check Fails

**Symptom:** `/health/detailed` returns "unhealthy" status.

**Solutions:**
- Check individual health checks in the response
- If database unhealthy: Verify Supabase connection
- If scheduler unhealthy: Check scheduler logs for startup errors
- If system unhealthy: Check resource usage

#### 4. High Memory Usage

**Symptom:** Memory percent consistently above 80%.

**Solutions:**
- Check for memory leaks in application code
- Review Prophet model caching (models can be large)
- Reduce Prophet `uncertainty_samples` parameter
- Scale up server resources

#### 5. Slow API Responses

**Symptom:** Requests taking >2 seconds.

**Solutions:**
- Check `/metrics` for system resource usage
- Review database query performance
- Check Supabase dashboard for slow queries
- Enable database query logging temporarily
- Consider adding caching

### Debug Mode

**Enable debug logging:**
```bash
LOG_LEVEL=DEBUG
```

This will log:
- All HTTP requests and responses
- Database queries
- Scheduler job execution
- Model training details

**Warning:** Debug mode generates large log files. Don't use in production long-term.

### Log Analysis

**Find errors in logs:**
```bash
grep "ERROR" logs/app.log
```

**Find slow requests:**
```bash
grep "duration_ms" logs/app.log | awk '$NF > 1000'
```

**Tail logs in real-time:**
```bash
tail -f logs/app.log
```

**Analyze JSON logs with jq:**
```bash
cat logs/app.log | jq 'select(.level == "ERROR")'
```

### Getting Help

1. **Check Logs First**: Always start by checking application logs
2. **Verify Configuration**: Ensure environment variables are set correctly
3. **Check Dependencies**: Verify external services (Supabase, Sentry) are operational
4. **Review Recent Changes**: Check git history for recent code changes
5. **Consult Documentation**: Review API docs and code comments

## Monitoring Checklist

### Daily
- [ ] Check Sentry for new errors
- [ ] Review `/health/detailed` status
- [ ] Check scheduler job history for failures

### Weekly
- [ ] Review error trends in Sentry
- [ ] Analyze slow query logs
- [ ] Check disk space and log rotation
- [ ] Review system resource trends

### Monthly
- [ ] Update alert thresholds based on trends
- [ ] Review and archive old logs
- [ ] Test disaster recovery procedures
- [ ] Update monitoring documentation

## Best Practices

1. **Log Meaningful Messages**: Include context (user_id, request_id, etc.)
2. **Use Appropriate Log Levels**: DEBUG for development, INFO for production events, ERROR for failures
3. **Don't Log Sensitive Data**: Never log passwords, API keys, or PII
4. **Monitor Proactively**: Set up alerts before issues become critical
5. **Keep Logs Secure**: Restrict access to production logs
6. **Rotate Logs Regularly**: Prevent disk space issues
7. **Test Monitoring**: Regularly verify alerts are working

## Resources

- [Sentry Documentation](https://docs.sentry.io/)
- [FastAPI Logging Best Practices](https://fastapi.tiangolo.com/tutorial/logging/)
- [Supabase Status](https://status.supabase.com/)
- [Python Logging Documentation](https://docs.python.org/3/library/logging.html)
