# Cost Forecasting Module

This module implements ML-based cost forecasting using Facebook Prophet, providing 30-day predictions with confidence intervals.

## Overview

The forecasting system:
- Uses Prophet for time-series prediction with weekly seasonality
- Trains separate models per provider for better accuracy
- Generates 30-day forecasts with 80% and 95% confidence intervals
- Handles missing data gracefully
- Detects changepoints (usage pattern changes)
- Stores predictions in the `forecast_results` table

## Components

### `prophet_model.py`

Core forecasting implementation with the `CostForecaster` class.

**Key Features:**
- Minimum 30 days of historical data required for training
- Weekly seasonality enabled (captures workday vs weekend patterns)
- Conservative changepoint detection (0.05 prior scale)
- Separate models per provider
- Confidence intervals at 80% and 95% levels
- Model versioning for tracking

**Main Methods:**

```python
# Initialize forecaster for a user
forecaster = CostForecaster(user_id="user-uuid")

# Train models on historical data
training_metadata = forecaster.train(provider_id=None)  # None = all providers

# Generate forecasts
forecast_df = forecaster.forecast(days=30, provider_id=None)

# Save forecasts to database
forecaster.save_forecast_to_db(forecast_df)

# Convenience method: train and forecast in one call
forecast_df, metadata = forecaster.train_and_forecast(
    forecast_days=30,
    provider_id=None,
    save_to_db=True
)

# Retrieve latest forecasts from database
latest_forecasts = forecaster.get_latest_forecasts(provider_id=None, days=30)
```

### `routers/forecast.py`

FastAPI endpoints for forecast generation and retrieval.

**Endpoints:**

#### `GET /api/forecast/health`
Health check for forecasting service.

**Response:**
```json
{
  "status": "healthy",
  "model_version": "prophet-v1.0",
  "min_training_days": 30
}
```

#### `POST /api/forecast/generate`
Generate new forecasts by training models on historical data.

**Request:**
```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "provider_id": "optional-provider-uuid",
  "days": 30,
  "save_to_db": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Successfully generated 30-day forecast",
  "forecasts": [
    {
      "date": "2026-02-12",
      "predicted_cost": 75.50,
      "lower_bound_80": 65.20,
      "upper_bound_80": 85.80,
      "lower_bound_95": 60.10,
      "upper_bound_95": 90.90,
      "provider_id": "provider-uuid"
    }
  ],
  "metadata": {
    "providers": ["provider-uuid"],
    "models_trained": 1,
    "record_count": 60,
    "training_period": {
      "start": "2025-12-13",
      "end": "2026-02-11"
    }
  }
}
```

**Error Responses:**
- `422 Unprocessable Entity`: Insufficient data (< 30 days)
- `400 Bad Request`: Validation error (invalid UUID, etc.)
- `500 Internal Server Error`: Unexpected error

#### `GET /api/forecast/latest`
Retrieve most recent forecasts from database (fast, no retraining).

**Query Parameters:**
- `user_id` (required): User UUID
- `provider_id` (optional): Filter by provider
- `days` (optional, default: 30): Number of days to retrieve

**Response:** Same format as `/generate` but with metadata from stored forecasts.

#### `POST /api/forecast/train`
Train models without generating forecasts (for testing/pre-training).

**Query Parameters:**
- `user_id` (required): User UUID
- `provider_id` (optional): Train specific provider model

**Response:**
```json
{
  "success": true,
  "message": "Models trained successfully",
  "metadata": {
    "providers": ["provider-1", "provider-2"],
    "models_trained": 2,
    "record_count": 120,
    "training_period": {
      "start": "2025-12-13",
      "end": "2026-02-11"
    }
  }
}
```

## Prophet Configuration

The Prophet model is configured with these settings:

```python
Prophet(
    yearly_seasonality=False,     # Cost patterns don't repeat yearly
    weekly_seasonality=True,       # Capture workday vs weekend usage
    daily_seasonality=False,       # Daily patterns not relevant
    changepoint_prior_scale=0.05,  # Conservative (less sensitive)
    interval_width=0.95,           # 95% confidence intervals
    uncertainty_samples=1000       # For confidence interval calculation
)
```

## Data Requirements

**Minimum Requirements:**
- At least 30 days of historical cost data
- At least one cost record per day (gaps are filled with zeros)

**Recommended:**
- 60+ days for more accurate predictions
- Consistent daily usage patterns

## Usage Examples

### Generate Forecast via API

```bash
curl -X POST "http://localhost:8000/api/forecast/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "days": 30,
    "save_to_db": true
  }'
```

### Generate Forecast for Specific Provider

```bash
curl -X POST "http://localhost:8000/api/forecast/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "provider_id": "anthropic-provider-uuid",
    "days": 30,
    "save_to_db": true
  }'
```

### Retrieve Latest Forecasts

```bash
curl "http://localhost:8000/api/forecast/latest?user_id=550e8400-e29b-41d4-a716-446655440000&days=30"
```

### Using Python Client

```python
from app.forecasting.prophet_model import CostForecaster

# Initialize
forecaster = CostForecaster(user_id="user-uuid")

# Train and forecast
try:
    forecast_df, metadata = forecaster.train_and_forecast(
        forecast_days=30,
        provider_id=None,
        save_to_db=True
    )

    print(f"Generated {len(forecast_df)} forecasts")
    print(f"Average daily cost: ${forecast_df['predicted_cost'].mean():.2f}")

except InsufficientDataError as e:
    print(f"Need more data: {e}")
```

## Database Schema

Forecasts are stored in the `forecast_results` table:

```sql
forecast_results (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    provider_id UUID,
    model_name VARCHAR(100),
    forecast_date DATE NOT NULL,
    predicted_cost_usd NUMERIC(12, 6) NOT NULL,
    lower_bound_80 NUMERIC(12, 6),
    upper_bound_80 NUMERIC(12, 6),
    lower_bound_95 NUMERIC(12, 6),
    upper_bound_95 NUMERIC(12, 6),
    confidence_score NUMERIC(3, 2),
    model_version VARCHAR(50) NOT NULL,
    training_data_start DATE NOT NULL,
    training_data_end DATE NOT NULL,
    training_record_count INTEGER NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
)
```

## Error Handling

### InsufficientDataError

Raised when there's not enough historical data to train models.

**Minimum required:** 30 days of data

**Example:**
```python
try:
    forecaster.train()
except InsufficientDataError as e:
    print(f"Need at least 30 days of data. Currently have: {e}")
```

### Missing Data

The system handles missing dates by filling gaps with zero costs. This prevents Prophet from failing on discontinuous data.

### No Negative Costs

All predicted costs and confidence bounds are clipped to zero minimum (no negative predictions).

## Model Retraining

**Recommended Schedule:**
- Weekly retraining for active users
- Monthly retraining for occasional users
- Trigger retraining when usage patterns change significantly

The scheduler service should be configured to call `/api/forecast/generate` periodically.

## Performance Considerations

- **Training time:** ~2-5 seconds per provider for 60 days of data
- **Forecast generation:** ~1-2 seconds per provider
- **Database storage:** ~1KB per forecast record
- **Caching:** Use `/api/forecast/latest` to retrieve cached forecasts instead of retraining

## Future Enhancements

Potential improvements for future versions:

1. **Model persistence**: Save trained models with pickle for faster loading
2. **Confidence scoring**: Add model confidence metrics based on prediction accuracy
3. **Multi-model ensemble**: Combine Prophet with other models (ARIMA, LSTM)
4. **Anomaly detection**: Flag unusual spending patterns
5. **Custom seasonality**: Allow users to define custom seasonality patterns
6. **A/B testing**: Compare forecast accuracy across different model configurations

## Testing

Run the test suite:

```bash
cd python-service
python test_forecast.py
```

Tests cover:
- Prophet configuration
- Missing date handling
- Forecast generation with synthetic data
- Confidence interval validation
- Data structure validation

## Troubleshooting

### "No module named 'prophet'"

Install dependencies:
```bash
pip install -r requirements.txt
```

### "Insufficient data" error

Ensure you have at least 30 days of cost records in the database.

### Forecast looks flat/unrealistic

- Check if there's sufficient data variability
- Verify weekly patterns exist in historical data
- Consider adjusting `changepoint_prior_scale` for more/less sensitivity

### Confidence intervals too wide

- More historical data typically reduces uncertainty
- Consistent usage patterns produce tighter intervals
- Weekly retraining helps adapt to new patterns
