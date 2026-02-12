# API Routes Documentation

This directory contains Next.js API routes for the AI Cost Dashboard application.

## Overview

All API routes are server-side only and require authentication via Supabase Auth. They enforce Row-Level Security (RLS) to ensure users can only access their own data.

## Authentication

All routes check for authentication using the `requireAuth()` helper from `@/lib/db`. Unauthenticated requests return `401 Unauthorized`.

```typescript
const userId = await requireAuth(cookieStore)
```

## Routes

### 1. `/api/costs` - Cost Records Query

**Method**: `GET`

**Description**: Query cost records with flexible filtering and aggregation.

**Query Parameters**:
- `startDate` (optional): ISO datetime, default: 30 days ago
- `endDate` (optional): ISO datetime, default: now
- `providers` (optional): Comma-separated provider UUIDs
- `granularity` (optional): `hour` | `day` | `week` | `month` (default: `day`)
- `limit` (optional): Max number of records

**Response**:
```json
{
  "data": [
    {
      "date": "2026-02-11",
      "provider_id": "uuid",
      "model_name": "gpt-4",
      "total_cost_usd": 12.34,
      "total_tokens": 50000,
      "total_requests": 100,
      ...
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

**Example**:
```bash
GET /api/costs?startDate=2026-01-01T00:00:00Z&endDate=2026-02-01T00:00:00Z&granularity=week
```

**Performance Notes**:
- For `day` granularity, uses `cost_records_daily` materialized view (fast)
- For other granularities, aggregates raw `cost_records` table
- Add `limit` parameter for large date ranges

---

### 2. `/api/costs/summary` - Cost Summary Metrics

**Method**: `GET`

**Description**: Get aggregated cost metrics and breakdowns.

**Query Parameters**:
- `startDate` (optional): ISO datetime, default: 30 days ago
- `endDate` (optional): ISO datetime, default: now
- `providers` (optional): Comma-separated provider UUIDs

**Response**:
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

**Example**:
```bash
GET /api/costs/summary?startDate=2026-01-01T00:00:00Z
```

**Use Cases**:
- Dashboard KPI cards (total cost, avg cost per request)
- Provider breakdown pie chart
- Top models ranking
- Identify highest spend days

---

### 3. `/api/costs/manual` - Manual Cost Entry

**Method**: `POST`

**Description**: Add manual cost entries for providers without API access (ChatGPT, Claude Desktop).

**Request Body** (Single Entry):
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
    "note": "ChatGPT Pro usage"
  }
}
```

**Request Body** (Bulk Import):
```json
{
  "entries": [
    { /* entry 1 */ },
    { /* entry 2 */ },
    ...
  ]
}
```

**Response**:
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
    ...
  }
}
```

**Bulk Response**:
```json
{
  "message": "Successfully imported 250 cost records",
  "count": 250,
  "data": [ /* array of created records */ ]
}
```

**Limits**:
- Bulk import: max 1000 entries per request
- Cost: max $999,999 per entry
- All fields validated with Zod schemas

**Example**:
```bash
curl -X POST /api/costs/manual \
  -H "Content-Type: application/json" \
  -d '{
    "provider_id": "chatgpt-provider-id",
    "timestamp": "2026-02-11T14:00:00Z",
    "model_name": "gpt-4",
    "cost_usd": 5.00
  }'
```

---

### 4. `/api/providers` - Provider & Credentials Management

#### GET - List Providers with Credentials

**Method**: `GET`

**Description**: List all active providers with user's API credentials (masked).

**Response**:
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
        "credential_name": "My Anthropic Key",
        "masked_key": "***3456",
        "is_active": true,
        "validation_status": "valid",
        "created_at": "2026-01-15T10:00:00Z"
      }
    ]
  }
]
```

**Example**:
```bash
GET /api/providers
```

#### POST - Add API Credential

**Method**: `POST`

**Description**: Add new API credential for a provider. Proxies to Python backend for encryption.

**Request Body**:
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

**Response**:
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

**Backend Flow**:
1. Frontend validates request
2. Calls Python backend `/api/credentials` endpoint
3. Backend encrypts key with AES-256 (Fernet)
4. Backend stores encrypted key in `api_credentials` table
5. Returns masked credential to frontend

**Example**:
```bash
curl -X POST /api/providers \
  -H "Content-Type: application/json" \
  -d '{
    "provider_id": "anthropic-uuid",
    "credential_name": "My Key",
    "api_key": "sk-ant-api03-..."
  }'
```

#### DELETE - Revoke Credential

**Method**: `DELETE`

**Description**: Revoke (deactivate) an API credential.

**Query Parameters**:
- `credential_id` (required): UUID of credential to revoke

**Response**:
```json
{
  "message": "API credential revoked successfully",
  "credential_id": "uuid"
}
```

**Example**:
```bash
DELETE /api/providers?credential_id=cred-uuid
```

**Notes**:
- Soft delete (sets `is_active = false`)
- Encrypted key retained in database for audit trail
- Data collectors will skip inactive credentials

---

### 5. `/api/backfill/[provider]` - Historical Data Backfill

**Method**: `POST`

**Description**: Trigger historical data collection for a provider (Anthropic or OpenAI).

**URL Parameters**:
- `provider`: `anthropic` | `openai`

**Request Body**:
```json
{
  "start_date": "2026-01-01T00:00:00Z",
  "end_date": "2026-01-31T23:59:59Z",
  "force": false
}
```

**Fields**:
- `start_date`: Start of date range to backfill
- `end_date`: End of date range to backfill
- `force`: If true, overwrite existing data (default: false)

**Response**:
```json
{
  "message": "Backfill initiated for anthropic",
  "job_id": "backfill-uuid",
  "status": "queued",
  "estimated_records": 1000
}
```

**Limits**:
- Max range: 90 days per request
- end_date cannot be in future
- Requires active API credentials for provider

**Example**:
```bash
curl -X POST /api/backfill/anthropic \
  -H "Content-Type: application/json" \
  -d '{
    "start_date": "2026-01-01T00:00:00Z",
    "end_date": "2026-01-31T23:59:59Z"
  }'
```

**Backend Flow**:
1. Validates date range and credentials
2. Calls Python backend `/api/backfill/{provider}` endpoint
3. Backend queues data collection job
4. Job runs asynchronously, fetching historical data
5. Cost records inserted into database

**Use Cases**:
- Initial setup: backfill last 30-90 days of data
- Fill gaps: if scheduled collection missed days
- Historical analysis: load data from before dashboard deployment

---

## Error Handling

All routes return standardized error responses:

```json
{
  "error": "Error message here",
  "details": { /* optional additional info */ }
}
```

**HTTP Status Codes**:
- `200` - Success
- `201` - Created (POST requests)
- `400` - Bad Request (validation error)
- `401` - Unauthorized (not authenticated)
- `403` - Forbidden (authenticated but not authorized)
- `404` - Not Found
- `500` - Internal Server Error

## Validation

All inputs validated with **Zod schemas** in `/lib/validation.ts`:

- Type safety at runtime
- Automatic error messages
- Schema composition and reuse

Example validation error:
```json
{
  "error": "Validation error: cost_usd must be a positive number"
}
```

## Database Access

All routes use:
1. **Supabase client** from `/lib/db.ts`
2. **Row-Level Security (RLS)** - automatic user data isolation
3. **Typed queries** - TypeScript types from `Database` type

Example:
```typescript
const supabase = await createClient(cookieStore)
const { data } = await supabase
  .from("cost_records")
  .select("*")
  .eq("user_id", userId) // RLS enforces this automatically
```

## Performance Optimizations

1. **Materialized View**: Day-granularity queries use `cost_records_daily` for ~100x speedup
2. **Indexes**: All queries hit indexed columns (user_id, timestamp, provider_id)
3. **Partitioning**: `cost_records` table partitioned by month for fast time-range queries
4. **Limit Parameters**: All list endpoints support pagination/limiting

## Rate Limiting

**TODO**: Add rate limiting middleware to prevent abuse.

Recommended limits:
- 100 requests/minute per user
- 10 backfill requests/hour per user
- 1000 manual entries/hour per user

## Testing

**Unit Tests**: (TODO)
```bash
npm run test:api
```

**Integration Tests**: (TODO)
```bash
npm run test:integration
```

**Manual Testing**:
```bash
# Start dev server
npm run dev

# Test with curl
curl http://localhost:3000/api/costs/summary

# Test with authenticated session (copy session cookie from browser)
curl http://localhost:3000/api/costs \
  -H "Cookie: sb-access-token=..."
```

## Deployment

API routes deploy automatically with Next.js app:

**Vercel**:
- Deployed as serverless functions
- Cold start: ~200-500ms
- Max execution time: 10s (Hobby), 60s (Pro)

**Environment Variables** (Required):
```bash
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
NEXT_PUBLIC_API_URL=https://backend.example.com
```

## Frontend Integration

Use with **TanStack Query**:

```typescript
// components/hooks/useCostSummary.ts
import { useQuery } from '@tanstack/react-query'

export function useCostSummary(startDate?: string, endDate?: string) {
  return useQuery({
    queryKey: ['cost-summary', startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)

      const res = await fetch(`/api/costs/summary?${params}`)
      if (!res.ok) throw new Error('Failed to fetch summary')
      return res.json()
    }
  })
}

// In component:
function Dashboard() {
  const { data, isLoading } = useCostSummary()

  if (isLoading) return <Spinner />

  return (
    <div>
      <h1>Total Cost: ${data.total_cost}</h1>
      {/* ... */}
    </div>
  )
}
```

## Security Checklist

- [x] Authentication required on all routes
- [x] Row-Level Security (RLS) enforced
- [x] Input validation with Zod
- [x] SQL injection prevented (Supabase client uses parameterized queries)
- [x] API keys encrypted in database (Python backend)
- [x] API keys masked in responses
- [x] HTTPS only in production
- [ ] Rate limiting (TODO)
- [ ] CSRF protection (TODO)

## Future Enhancements

1. **Real-time subscriptions** - WebSocket for live cost updates
2. **Bulk operations** - Batch delete/update endpoints
3. **Export endpoints** - CSV/Excel export of cost data
4. **Webhook integration** - Notify external services of cost events
5. **GraphQL API** - Alternative to REST for complex queries
6. **API versioning** - `/api/v2/costs` for breaking changes

---

For questions or issues, see:
- Database schema: `/database/README.md`
- Frontend setup: `/README.md`
- Backend API: `/python-service/README.md`
