# AI Cost Dashboard - API Documentation

Complete reference for the AI Cost Dashboard REST API.

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Endpoints](#endpoints)
4. [Error Handling](#error-handling)
5. [Rate Limiting](#rate-limiting)
6. [Examples](#examples)

---

## Overview

### Base URL

```
Production: https://your-domain.vercel.app/api
Development: http://localhost:3000/api
```

### API Version

Current version: **v1** (no versioning prefix in URLs)

### Content Type

All requests and responses use `application/json`.

### Response Format

All successful responses follow this format:

```json
{
  "data": { /* response data */ },
  "count": 10, // optional, for list endpoints
  "meta": { /* optional metadata */ }
}
```

Error responses:

```json
{
  "error": "Error message",
  "details": { /* optional error details */ }
}
```

---

## Authentication

### Session-Based Auth

The API uses **Supabase Auth** with HTTP-only cookies for session management.

**Login Flow:**
1. User logs in via `/login` page
2. Supabase sets session cookie
3. Cookie automatically sent with all API requests
4. Middleware validates session and extracts `user_id`

**No API keys required** for frontend clients - authentication handled by cookies.

### Row-Level Security (RLS)

All queries automatically filtered by authenticated user's `user_id`. Users can only access their own data.

### Checking Auth Status

```typescript
// Frontend
const { data: { user } } = await supabase.auth.getUser()
if (!user) {
  // Redirect to /login
}
```

---

## Endpoints

### Cost Records

#### GET /api/costs

Query cost records with flexible filtering.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startDate` | ISO datetime | No | 30 days ago | Start of date range |
| `endDate` | ISO datetime | No | Now | End of date range |
| `providers` | string | No | All | Comma-separated provider IDs |
| `granularity` | enum | No | `day` | `hour`, `day`, `week`, or `month` |
| `limit` | integer | No | Unlimited | Max records to return |

**Response:**

```json
{
  "data": [
    {
      "date": "2026-02-11",
      "provider_id": "uuid",
      "model_name": "gpt-4",
      "total_cost_usd": 12.34,
      "total_tokens": 50000,
      "total_input_tokens": 40000,
      "total_output_tokens": 10000,
      "total_requests": 100,
      "record_count": 15
    }
  ],
  "count": 30,
  "granularity": "day",
  "period": {
    "start": "2026-01-12T00:00:00.000Z",
    "end": "2026-02-11T23:59:59.999Z"
  }
}
```

**Example:**

```bash
curl "https://api.example.com/api/costs?startDate=2026-01-01T00:00:00Z&granularity=week" \
  -H "Cookie: sb-access-token=..."
```

**Notes:**
- `day` granularity uses materialized view for fast queries
- Other granularities aggregate raw cost_records table
- Date range limited to 1 year maximum

---

#### GET /api/costs/summary

Get aggregated cost metrics and breakdowns.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startDate` | ISO datetime | No | 30 days ago | Start of date range |
| `endDate` | ISO datetime | No | Now | End of date range |
| `providers` | string | No | All | Comma-separated provider IDs |

**Response:**

```json
{
  "total_cost": 145.67,
  "total_requests": 1234,
  "total_tokens": 567890,
  "avg_cost_per_request": 0.118,
  "avg_cost_per_token": 0.000256,
  "period_start": "2026-01-12T00:00:00.000Z",
  "period_end": "2026-02-11T23:59:59.999Z",
  "by_provider": [
    {
      "provider_id": "uuid",
      "provider_name": "Anthropic",
      "total_cost": 89.12,
      "total_requests": 800,
      "percentage": 61.2
    }
  ],
  "by_model": [
    {
      "model_name": "gpt-4",
      "total_cost": 56.34,
      "total_requests": 300,
      "percentage": 38.7
    }
  ],
  "top_cost_day": {
    "date": "2026-02-05",
    "cost": 23.45
  }
}
```

**Example:**

```bash
curl "https://api.example.com/api/costs/summary?startDate=2026-01-01T00:00:00Z" \
  -H "Cookie: sb-access-token=..."
```

---

#### POST /api/costs/manual

Add manual cost entry or bulk import from CSV.

**Single Entry Request:**

```json
{
  "provider_id": "uuid",
  "timestamp": "2026-02-11T14:30:00Z",
  "model_name": "gpt-4",
  "cost_usd": 2.50,
  "tokens_used": 10000,
  "input_tokens": 8000,
  "output_tokens": 2000,
  "request_count": 5,
  "metadata": {
    "notes": "ChatGPT Pro usage"
  }
}
```

**Bulk Import Request:**

```json
{
  "entries": [
    {
      "provider_id": "uuid",
      "timestamp": "2026-02-11T12:00:00Z",
      "model_name": "gpt-4",
      "cost_usd": 5.50,
      "metadata": { "notes": "Project work" }
    },
    {
      "provider_id": "uuid",
      "timestamp": "2026-02-10T15:00:00Z",
      "model_name": "gpt-3.5-turbo",
      "cost_usd": 1.25,
      "metadata": { "notes": "Research" }
    }
  ]
}
```

**Response (Single):**

```json
{
  "message": "Manual cost entry created successfully",
  "data": {
    "id": "uuid",
    "user_id": "uuid",
    "provider_id": "uuid",
    "timestamp": "2026-02-11T14:30:00Z",
    "model_name": "gpt-4",
    "cost_usd": 2.50,
    "collection_method": "manual_entry",
    "created_at": "2026-02-11T14:31:00Z"
  }
}
```

**Response (Bulk):**

```json
{
  "message": "Successfully imported 250 cost records",
  "count": 250,
  "data": [ /* array of created records */ ]
}
```

**Validation:**
- `cost_usd`: Must be positive, max $999,999
- `timestamp`: Must be valid ISO datetime
- `model_name`: Required, max 100 chars
- Bulk: Max 1000 entries per request

**Example:**

```bash
curl -X POST "https://api.example.com/api/costs/manual" \
  -H "Cookie: sb-access-token=..." \
  -H "Content-Type: application/json" \
  -d '{
    "provider_id": "chatgpt-uuid",
    "timestamp": "2026-02-11T14:00:00Z",
    "model_name": "gpt-4",
    "cost_usd": 5.00
  }'
```

---

### Providers and Credentials

#### GET /api/providers

List all providers with user's API credentials.

**Response:**

```json
[
  {
    "id": "uuid",
    "name": "anthropic",
    "display_name": "Anthropic (Claude API)",
    "api_base_url": "https://api.anthropic.com",
    "is_active": true,
    "credentials": [
      {
        "id": "cred-uuid",
        "credential_name": "Production Key",
        "masked_key": "***3456",
        "is_active": true,
        "validation_status": "valid",
        "created_at": "2026-01-15T10:00:00Z"
      }
    ]
  }
]
```

**Example:**

```bash
curl "https://api.example.com/api/providers" \
  -H "Cookie: sb-access-token=..."
```

---

#### POST /api/providers

Add new API credential for a provider.

**Request:**

```json
{
  "provider_id": "uuid",
  "credential_name": "Production Key",
  "api_key": "sk-ant-api03-actual-key-here",
  "metadata": {
    "organization_id": "org-123"
  }
}
```

**Response:**

```json
{
  "message": "API credential added successfully",
  "credential": {
    "id": "uuid",
    "credential_name": "Production Key",
    "encrypted_api_key": "***encrypted***",
    "is_active": true,
    "created_at": "2026-02-11T14:00:00Z"
  }
}
```

**Backend Flow:**
1. Frontend validates request
2. Calls Python backend `/api/credentials` endpoint
3. Backend encrypts key with AES-256
4. Stores encrypted key in database
5. Returns masked credential

**Example:**

```bash
curl -X POST "https://api.example.com/api/providers" \
  -H "Cookie: sb-access-token=..." \
  -H "Content-Type: application/json" \
  -d '{
    "provider_id": "anthropic-uuid",
    "credential_name": "My Key",
    "api_key": "sk-ant-api03-..."
  }'
```

---

#### DELETE /api/providers

Revoke (deactivate) an API credential.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `credential_id` | UUID | Yes | Credential to revoke |

**Response:**

```json
{
  "message": "API credential revoked successfully",
  "credential_id": "uuid"
}
```

**Example:**

```bash
curl -X DELETE "https://api.example.com/api/providers?credential_id=cred-uuid" \
  -H "Cookie: sb-access-token=..."
```

**Notes:**
- Soft delete (sets `is_active = false`)
- Encrypted key retained for audit trail
- Data collectors will skip inactive credentials

---

### Backfill

#### POST /api/backfill/[provider]

Trigger historical data collection for a provider.

**URL Parameters:**

| Parameter | Type | Values |
|-----------|------|--------|
| `provider` | string | `anthropic` or `openai` |

**Request:**

```json
{
  "start_date": "2026-01-01T00:00:00Z",
  "end_date": "2026-01-31T23:59:59Z",
  "force": false
}
```

**Fields:**
- `start_date`: Start of date range to backfill
- `end_date`: End of date range
- `force`: If true, overwrite existing data (default: false)

**Response:**

```json
{
  "message": "Backfill initiated for anthropic",
  "job_id": "backfill-uuid",
  "status": "queued",
  "estimated_records": 1000
}
```

**Limits:**
- Max range: 90 days per request
- `end_date` cannot be in future
- Requires active API credentials for provider

**Example:**

```bash
curl -X POST "https://api.example.com/api/backfill/anthropic" \
  -H "Cookie: sb-access-token=..." \
  -H "Content-Type: application/json" \
  -d '{
    "start_date": "2026-01-01T00:00:00Z",
    "end_date": "2026-01-31T23:59:59Z"
  }'
```

**Backend Flow:**
1. Validates date range and credentials
2. Calls Python backend `/api/backfill/{provider}`
3. Backend queues data collection job
4. Job runs asynchronously
5. Cost records inserted into database

---

## Error Handling

### HTTP Status Codes

| Code | Meaning | Description |
|------|---------|-------------|
| 200 | OK | Request successful |
| 201 | Created | Resource created successfully (POST) |
| 400 | Bad Request | Invalid parameters or validation error |
| 401 | Unauthorized | Not authenticated (no valid session) |
| 403 | Forbidden | Authenticated but not authorized |
| 404 | Not Found | Resource not found |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server error |
| 503 | Service Unavailable | Temporary server issue |

### Error Response Format

```json
{
  "error": "Human-readable error message",
  "details": {
    "field": "provider_id",
    "reason": "Invalid UUID format"
  }
}
```

### Common Errors

**401 Unauthorized**

```json
{
  "error": "Unauthorized"
}
```

**Cause:** No valid session cookie
**Solution:** Log in again

**400 Validation Error**

```json
{
  "error": "Validation error: cost_usd must be a positive number"
}
```

**Cause:** Invalid request parameters
**Solution:** Check request schema

**404 Not Found**

```json
{
  "error": "Provider not found"
}
```

**Cause:** Invalid provider ID or resource doesn't exist
**Solution:** Verify IDs are correct

**429 Rate Limited**

```json
{
  "error": "Rate limit exceeded. Please try again in 60 seconds."
}
```

**Cause:** Too many requests in short time
**Solution:** Wait and retry with exponential backoff

---

## Rate Limiting

### Current Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| All GET requests | 100/minute | Per user |
| POST /api/costs/manual | 50/hour | Per user |
| POST /api/providers | 10/hour | Per user |
| POST /api/backfill/* | 5/hour | Per user |

### Rate Limit Headers

Responses include rate limit info:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1612137600
```

### Handling Rate Limits

**Retry Logic:**

```typescript
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options)

    if (response.status === 429) {
      const resetTime = parseInt(response.headers.get('X-RateLimit-Reset') || '0')
      const waitTime = (resetTime * 1000) - Date.now()
      await new Promise(resolve => setTimeout(resolve, Math.max(waitTime, 1000)))
      continue
    }

    return response
  }

  throw new Error('Max retries exceeded')
}
```

---

## Examples

### Frontend Integration with TanStack Query

#### Fetching Cost Summary

```typescript
import { useQuery } from '@tanstack/react-query'

export function useCostSummary(startDate?: string, endDate?: string) {
  return useQuery({
    queryKey: ['cost-summary', startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)

      const res = await fetch(`/api/costs/summary?${params}`)
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error)
      }
      return res.json()
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

// In component:
function Dashboard() {
  const { data, isLoading, error } = useCostSummary()

  if (isLoading) return <Spinner />
  if (error) return <Error message={error.message} />

  return (
    <div>
      <h1>Total Cost: ${data.total_cost}</h1>
      {/* ... */}
    </div>
  )
}
```

#### Adding Manual Entry

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query'

export function useAddManualEntry() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (entry: ManualEntry) => {
      const res = await fetch('/api/costs/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error)
      }

      return res.json()
    },
    onSuccess: () => {
      // Invalidate and refetch
      queryClient.invalidateQueries({ queryKey: ['cost-records'] })
    },
  })
}

// In component:
function ManualEntryForm() {
  const mutation = useAddManualEntry()

  const onSubmit = (data: FormData) => {
    mutation.mutate({
      provider_id: 'chatgpt-uuid',
      timestamp: new Date(data.date).toISOString(),
      model_name: data.model,
      cost_usd: parseFloat(data.cost),
    })
  }

  return <form onSubmit={onSubmit}>...</form>
}
```

### Python Backend Integration

#### Calling Next.js API from Python

```python
import requests

class DashboardClient:
    def __init__(self, base_url: str, session_cookie: str):
        self.base_url = base_url
        self.session = requests.Session()
        self.session.cookies.set('sb-access-token', session_cookie)

    def get_cost_summary(self, start_date: str, end_date: str):
        response = self.session.get(
            f"{self.base_url}/api/costs/summary",
            params={'startDate': start_date, 'endDate': end_date}
        )
        response.raise_for_status()
        return response.json()

    def add_manual_entry(self, provider_id: str, cost_data: dict):
        response = self.session.post(
            f"{self.base_url}/api/costs/manual",
            json={
                'provider_id': provider_id,
                **cost_data
            }
        )
        response.raise_for_status()
        return response.json()

# Usage:
client = DashboardClient('https://api.example.com', session_cookie='...')
summary = client.get_cost_summary('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')
print(f"Total cost: ${summary['total_cost']}")
```

### cURL Examples

#### Get Cost Summary

```bash
curl -X GET "https://api.example.com/api/costs/summary?startDate=2026-01-01T00:00:00Z&endDate=2026-02-01T00:00:00Z" \
  -H "Cookie: sb-access-token=your-session-token" \
  -H "Accept: application/json"
```

#### Add Manual Entry

```bash
curl -X POST "https://api.example.com/api/costs/manual" \
  -H "Cookie: sb-access-token=your-session-token" \
  -H "Content-Type: application/json" \
  -d '{
    "provider_id": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-02-11T14:30:00Z",
    "model_name": "gpt-4",
    "cost_usd": 5.50,
    "metadata": {
      "notes": "Monthly project work"
    }
  }'
```

#### List Providers

```bash
curl -X GET "https://api.example.com/api/providers" \
  -H "Cookie: sb-access-token=your-session-token" \
  -H "Accept: application/json"
```

#### Add API Credential

```bash
curl -X POST "https://api.example.com/api/providers" \
  -H "Cookie: sb-access-token=your-session-token" \
  -H "Content-Type: application/json" \
  -d '{
    "provider_id": "550e8400-e29b-41d4-a716-446655440000",
    "credential_name": "Production Key",
    "api_key": "sk-ant-api03-your-actual-key-here"
  }'
```

---

## Pagination

Currently not implemented. All list endpoints return full results with optional `limit` parameter.

**Coming Soon:**
- Cursor-based pagination
- `next` and `previous` links in response
- `page` and `per_page` parameters

---

## Webhooks

Not currently supported.

**Coming Soon:**
- Cost threshold alerts
- Daily/weekly summary webhooks
- Data collection completion notifications

---

## Changelog

### v1.0 (Current)

**Initial Release:**
- Cost records query and summary
- Manual entry (single and bulk)
- Provider and credential management
- Historical backfill

**Coming Soon (v1.1):**
- Pagination support
- Webhook notifications
- Batch operations
- GraphQL API

---

## Support

**Documentation:**
- User Guide: `/docs/USER_GUIDE.md`
- Developer Guide: `/docs/LOCAL_DEVELOPMENT.md`
- Database Docs: `/database/README.md`

**Issues:**
- GitHub: [github.com/your-org/ai-cost-dashboard/issues](https://github.com)
- Email: support@example.com

**Community:**
- Discussions: GitHub Discussions
- Discord: [discord.gg/example](https://discord.com) (example)

---

**Last Updated:** February 11, 2026
**API Version:** 1.0
