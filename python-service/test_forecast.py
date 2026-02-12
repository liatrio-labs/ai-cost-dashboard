"""
Test script for Prophet forecasting model.

This script tests the forecasting functionality without requiring
a full database setup. It uses synthetic data for testing.
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from app.forecasting.prophet_model import CostForecaster


def generate_synthetic_data(days: int = 60) -> pd.DataFrame:
    """
    Generate synthetic cost data for testing.

    Creates data with weekly seasonality (higher costs on weekdays).
    """
    start_date = datetime.now() - timedelta(days=days)
    dates = pd.date_range(start=start_date, periods=days, freq='D')

    # Generate synthetic costs with weekly pattern
    costs = []
    for date in dates:
        # Base cost
        base_cost = 50.0

        # Weekly seasonality (higher on weekdays)
        day_of_week = date.dayofweek
        if day_of_week < 5:  # Weekday
            weekly_component = 20.0
        else:  # Weekend
            weekly_component = -10.0

        # Add some random noise
        noise = np.random.normal(0, 5)

        # Add slight upward trend
        trend = 0.5 * (date - dates[0]).days / 7

        total_cost = base_cost + weekly_component + noise + trend
        costs.append(max(0, total_cost))  # No negative costs

    df = pd.DataFrame({
        'ds': dates,
        'y': costs,
        'provider_id': 'test-provider-123'
    })

    return df


def test_prophet_configuration():
    """Test that Prophet model is configured correctly."""
    print("Testing Prophet model configuration...")

    forecaster = CostForecaster(user_id="test-user-123")
    model = forecaster._configure_prophet()

    assert model.yearly_seasonality == False
    assert model.weekly_seasonality == True
    assert model.daily_seasonality == False
    assert model.changepoint_prior_scale == 0.05
    assert model.interval_width == 0.95

    print("✓ Prophet configuration is correct")


def test_missing_date_handling():
    """Test that missing dates are handled correctly."""
    print("\nTesting missing date handling...")

    # Create data with missing dates
    dates = pd.date_range(start='2026-01-01', end='2026-01-31', freq='D')
    df = pd.DataFrame({
        'ds': dates,
        'y': np.random.uniform(10, 100, len(dates))
    })

    # Remove some dates
    df = df[df['ds'].dt.day % 3 != 0]  # Remove every 3rd day

    print(f"  Original records: {len(df)}")

    forecaster = CostForecaster(user_id="test-user-123")
    complete_df = forecaster._handle_missing_dates(df)

    print(f"  After filling: {len(complete_df)}")

    # Check that all dates are present
    expected_days = (dates[-1] - dates[0]).days + 1
    assert len(complete_df) == expected_days

    # Check that missing dates were filled with 0
    filled_dates = complete_df[complete_df['y'] == 0]
    print(f"  Dates filled with 0: {len(filled_dates)}")

    print("✓ Missing date handling works correctly")


def test_local_forecast():
    """Test forecast generation with synthetic data."""
    print("\nTesting forecast generation with synthetic data...")

    # Generate synthetic training data
    synthetic_data = generate_synthetic_data(days=60)
    print(f"  Generated {len(synthetic_data)} days of synthetic data")

    # Create a mock forecaster (we'll bypass database operations)
    forecaster = CostForecaster(user_id="test-user-123")

    # Train model directly with synthetic data
    model = forecaster._configure_prophet()
    train_data = synthetic_data[['ds', 'y']].copy()
    model.fit(train_data)

    print(f"  Model trained. Detected {len(model.changepoints)} changepoints")

    # Store the trained model
    provider_id = synthetic_data['provider_id'].iloc[0]
    forecaster.models[provider_id] = model
    forecaster.training_metadata[provider_id] = {
        "provider_id": provider_id,
        "training_start": train_data['ds'].min().date().isoformat(),
        "training_end": train_data['ds'].max().date().isoformat(),
        "record_count": len(train_data),
        "changepoints": len(model.changepoints),
        "trained_at": datetime.utcnow().isoformat()
    }

    # Generate forecast
    forecast_df = forecaster.forecast(days=30, provider_id=provider_id)

    print(f"  Generated {len(forecast_df)} forecast points")
    print(f"  Average predicted cost: ${forecast_df['predicted_cost'].mean():.2f}/day")
    print(f"  Predicted range: ${forecast_df['predicted_cost'].min():.2f} - ${forecast_df['predicted_cost'].max():.2f}")

    # Verify forecast structure
    assert len(forecast_df) == 30
    assert 'date' in forecast_df.columns
    assert 'predicted_cost' in forecast_df.columns
    assert 'lower_bound_80' in forecast_df.columns
    assert 'upper_bound_80' in forecast_df.columns
    assert 'lower_bound_95' in forecast_df.columns
    assert 'upper_bound_95' in forecast_df.columns

    # Verify no negative costs
    assert (forecast_df['predicted_cost'] >= 0).all()
    assert (forecast_df['lower_bound_80'] >= 0).all()
    assert (forecast_df['lower_bound_95'] >= 0).all()

    # Verify confidence intervals are sensible
    assert (forecast_df['lower_bound_80'] <= forecast_df['predicted_cost']).all()
    assert (forecast_df['predicted_cost'] <= forecast_df['upper_bound_80']).all()
    assert (forecast_df['lower_bound_95'] <= forecast_df['lower_bound_80']).all()
    assert (forecast_df['upper_bound_80'] <= forecast_df['upper_bound_95']).all()

    print("✓ Forecast generation works correctly")

    # Display sample forecast data
    print("\n  Sample forecast (first 7 days):")
    print(forecast_df.head(7).to_string(index=False))


def main():
    """Run all tests."""
    print("=" * 60)
    print("Prophet Forecasting Model - Test Suite")
    print("=" * 60)

    try:
        test_prophet_configuration()
        test_missing_date_handling()
        test_local_forecast()

        print("\n" + "=" * 60)
        print("All tests passed! ✓")
        print("=" * 60)

    except AssertionError as e:
        print(f"\n✗ Test failed: {str(e)}")
        raise

    except Exception as e:
        print(f"\n✗ Unexpected error: {str(e)}")
        raise


if __name__ == "__main__":
    main()
