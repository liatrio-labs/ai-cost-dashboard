# AI Cost Dashboard - Backend Service

FastAPI backend service for automated data collection from AI providers and ML-based cost forecasting.

## Overview

This Python service handles:
- **Automated Data Collection**: Scheduled collection from Anthropic and OpenAI APIs
- **ML Forecasting**: 30-day cost predictions using Facebook Prophet
- **API Endpoints**: RESTful API for dashboard frontend
- **Database Operations**: Supabase integration for data storage

## Tech Stack

- **FastAPI**: Modern Python web framework
- **Facebook Prophet**: Time-series forecasting
- **APScheduler**: Cron job scheduling
- **Supabase**: PostgreSQL database client
- **Anthropic SDK**: Claude API integration
- **OpenAI SDK**: GPT API integration

## Project Structure

```
python-service/
├── app/
│   ├── __init__.py
│   ├── main.py                 # FastAPI application entry point
│   ├── collectors/             # API data collectors
│   │   ├── __init__.py
│   │   ├── base.py            # Base collector class
│   │   ├── anthropic.py       # Anthropic API collector (TODO)
│   │   └── openai.py          # OpenAI API collector (TODO)
│   ├── forecasting/           # ML forecasting models
│   │   ├── __init__.py
│   │   └── prophet_model.py   # Prophet forecasting (TODO)
│   ├── routers/               # API routes
│   │   ├── __init__.py
│   │   ├── health.py          # Health check endpoints
│   │   ├── costs.py           # Cost data endpoints (TODO)
│   │   └── forecasts.py       # Forecast endpoints (TODO)
│   └── utils/                 # Utilities
│       ├── __init__.py
│       ├── supabase_client.py # Supabase client
│       └── encryption.py      # API key encryption (TODO)
├── requirements.txt           # Python dependencies
├── .env.example              # Environment variables template
└── README.md                 # This file
```

## Setup

### Prerequisites

- Python 3.11 or higher
- pip or uv package manager
- Supabase account with database configured
- Anthropic API key (Admin key for organization)
- OpenAI API key

### Installation

1. Navigate to the python-service directory:
```bash
cd python-service
```

2. Create a virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your actual values
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description | Required |
|----------|-------------|----------|
| `SUPABASE_URL` | Your Supabase project URL | Yes |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | Yes |
| `ANTHROPIC_API_KEY` | Anthropic API key (for testing) | No* |
| `OPENAI_API_KEY` | OpenAI API key (for testing) | No* |
| `ENCRYPTION_KEY` | 32-byte base64 key for encrypting API keys | Yes |
| `HOST` | Server host (default: 0.0.0.0) | No |
| `PORT` | Server port (default: 8000) | No |
| `ENVIRONMENT` | Environment name (development/production) | No |

\* API keys are stored encrypted in the database per user. These are only needed for local testing.

## Running the Service

### Development Mode

Start the server with auto-reload:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at:
- **API**: http://localhost:8000
- **API Docs**: http://localhost:8000/docs (Swagger UI)
- **ReDoc**: http://localhost:8000/redoc

### Production Mode

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

## API Endpoints

### Health Checks

- `GET /health` - Basic health check
- `GET /health/db` - Database connectivity check

### Costs (TODO)

- `GET /api/costs` - Get cost data with filters
- `POST /api/costs/collect` - Manually trigger data collection

### Forecasts (TODO)

- `GET /api/forecasts` - Get cost forecasts
- `POST /api/forecasts/train` - Retrain forecasting model

## Data Collection

### Collectors

Collectors inherit from `BaseCollector` and implement the required methods for data collection.

#### Anthropic Collector

The `AnthropicCollector` collects data from Anthropic's Admin API:

**Features:**
- Uses Admin API endpoints: `/v1/organizations/usage_report/messages` and `/v1/organizations/cost_report`
- Rate limiting: Max 1 request/minute sustained
- Automatic pagination with `next_page` tokens
- Exponential backoff retry logic
- Backfill support for historical data (up to 90 days)
- Data freshness: ~5 minutes

**Usage:**

```python
from app.collectors.anthropic_collector import AnthropicCollector

async with AnthropicCollector(
    api_key="your-admin-api-key",
    user_id="user-uuid",
    provider_id="provider-uuid"
) as collector:
    # Collect last 24 hours
    records = await collector.collect_data()

    # Or backfill historical data
    result = await collector.backfill_historical_data(days=30)

    # Or run full workflow (collect + store)
    result = await collector.run()
```

**API Endpoints Used:**

1. **Usage Report** (`POST /v1/organizations/usage_report/messages`):
   - Returns token usage and request counts
   - Supports granularity: 1m, 1h, 1d
   - Includes model, input_tokens, output_tokens, request_count

2. **Cost Report** (`POST /v1/organizations/cost_report`):
   - Returns cost in USD
   - Matches usage report time periods
   - Granular cost tracking per model

**Testing:**

```bash
# Test without database (transformation only)
python test_collector.py --api-key YOUR_KEY --skip-db

# Full test with database
python test_collector.py --api-key YOUR_KEY --user-id USER_UUID --provider-id PROVIDER_UUID
```

### Scheduled Collection

APScheduler runs collectors on configured intervals:
- **Anthropic**: Every hour (`0 * * * *`)
- **OpenAI**: Every 6 hours (`0 */6 * * *`)

## Forecasting

### Prophet Model

Uses Facebook Prophet for time-series forecasting:
- 30-day predictions
- Confidence intervals (80%, 95%)
- Weekly seasonality detection
- Automatic retraining

### Training

Model retrains automatically:
- When new data is collected
- On manual trigger via API
- Minimum 2 weeks of historical data required

## Database Schema

### Costs Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `user_id` | UUID | User who owns this record |
| `provider` | VARCHAR | Provider name (anthropic, openai, etc.) |
| `model` | VARCHAR | Model name |
| `date` | DATE | Date of usage |
| `cost` | DECIMAL | Cost in USD |
| `tokens_input` | INTEGER | Input tokens |
| `tokens_output` | INTEGER | Output tokens |
| `collected_at` | TIMESTAMP | When data was collected |
| `metadata` | JSONB | Additional provider-specific data |

## Development

### Adding a New Collector

1. Create a new file in `app/collectors/`
2. Inherit from `BaseCollector`
3. Implement required methods
4. Register in scheduler

Example:

```python
from app.collectors.base import BaseCollector

class NewProviderCollector(BaseCollector):
    @property
    def provider_name(self) -> str:
        return "new_provider"

    async def collect_data(self):
        # Implementation
        pass
```

### Testing

Run tests (when implemented):

```bash
pytest tests/
```

### Code Quality

Format code:

```bash
black app/
```

Check types:

```bash
mypy app/
```

## Deployment

### Render

This service is designed to deploy to Render:

1. Push code to GitHub
2. Create a new Web Service on Render
3. Configure environment variables
4. Set build command: `pip install -r requirements.txt`
5. Set start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

### Docker (Alternative)

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app/ app/
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## Monitoring

### Logs

Structured logging with timestamps:
- INFO: Normal operations
- WARNING: Potential issues
- ERROR: Collection failures

### Health Checks

Monitor endpoints:
- `/health` - Service status
- `/health/db` - Database connectivity

## Security

### API Key Storage

- Keys stored encrypted in database (AES-256)
- Service role key for Supabase operations
- Row-level security enforced

### Rate Limiting

- Implement rate limiting on all endpoints
- Protect against abuse

### HTTPS

- Enforce HTTPS in production
- Configure CORS for Vercel frontend

## Troubleshooting

### Database Connection Issues

```bash
# Test Supabase connection
python -c "from app.utils.supabase_client import test_connection; print(test_connection())"
```

### Collection Failures

Check logs for:
- API key validity
- Rate limiting
- Network issues

### Prophet Issues

Prophet requires:
- Minimum 2 weeks of data
- Regular data points (no large gaps)
- Valid date and cost columns

## Contributing

When adding features:
1. Follow existing code structure
2. Add type hints
3. Include docstrings
4. Update this README

## Support

For issues:
- Check logs in `/logs/` directory
- Review API documentation at `/docs`
- Contact team lead

---

Built for the AI Cost Dashboard project
