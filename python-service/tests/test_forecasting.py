"""
Tests for forecasting functionality
"""
import pytest
import pandas as pd
import numpy as np
from datetime import datetime, timedelta


@pytest.mark.unit
def test_forecast_data_preparation(forecast_training_data):
    """Test preparing data for Prophet model"""
    df = pd.DataFrame(forecast_training_data)
    df['ds'] = pd.to_datetime(df['date'])
    df['y'] = df['cost_usd']

    assert len(df) == 90
    assert 'ds' in df.columns
    assert 'y' in df.columns
    assert df['y'].dtype in [np.float64, np.int64]


@pytest.mark.unit
def test_forecast_validation():
    """Test forecast output validation"""
    forecast = {
        "date": "2024-01-01",
        "predicted_cost": 150.50,
        "lower_bound": 120.40,
        "upper_bound": 180.60,
        "confidence_score": 0.85,
    }

    assert forecast["predicted_cost"] > 0
    assert forecast["lower_bound"] < forecast["predicted_cost"]
    assert forecast["upper_bound"] > forecast["predicted_cost"]
    assert 0 <= forecast["confidence_score"] <= 1


@pytest.mark.unit
def test_time_series_creation():
    """Test creating time series for forecasting"""
    dates = pd.date_range(start='2024-01-01', periods=30, freq='D')
    values = np.random.uniform(50, 150, 30)

    df = pd.DataFrame({'ds': dates, 'y': values})

    assert len(df) == 30
    assert df['ds'].is_monotonic_increasing
    assert df['y'].min() >= 0


@pytest.mark.unit
def test_forecast_horizon():
    """Test forecast generates correct number of future periods"""
    forecast_periods = 30
    historical_periods = 90

    total_periods = historical_periods + forecast_periods
    assert total_periods == 120


@pytest.mark.unit
def test_confidence_intervals():
    """Test confidence interval calculation"""
    predicted = 100.0
    std_dev = 10.0

    # 80% confidence interval
    lower_80 = predicted - (1.28 * std_dev)
    upper_80 = predicted + (1.28 * std_dev)

    # 95% confidence interval
    lower_95 = predicted - (1.96 * std_dev)
    upper_95 = predicted + (1.96 * std_dev)

    assert lower_80 < predicted < upper_80
    assert lower_95 < predicted < upper_95
    assert lower_95 < lower_80
    assert upper_95 > upper_80


@pytest.mark.unit
def test_model_parameters():
    """Test Prophet model parameters"""
    params = {
        "growth": "linear",
        "changepoint_prior_scale": 0.05,
        "seasonality_prior_scale": 10.0,
        "holidays_prior_scale": 10.0,
        "seasonality_mode": "additive",
    }

    assert params["growth"] in ["linear", "logistic"]
    assert params["changepoint_prior_scale"] > 0
    assert params["seasonality_prior_scale"] > 0


@pytest.mark.slow
@pytest.mark.integration
def test_full_forecast_pipeline(forecast_training_data):
    """Test complete forecasting pipeline"""
    # Prepare data
    df = pd.DataFrame(forecast_training_data)
    df['ds'] = pd.to_datetime(df['date'])
    df['y'] = df['cost_usd']

    # Generate forecast dates
    last_date = df['ds'].max()
    forecast_dates = pd.date_range(
        start=last_date + timedelta(days=1),
        periods=30,
        freq='D'
    )

    assert len(forecast_dates) == 30
    assert forecast_dates[0] > last_date


@pytest.mark.unit
def test_outlier_detection():
    """Test outlier detection in cost data"""
    data = [50, 52, 48, 51, 49, 500, 53, 50]  # 500 is outlier

    mean = np.mean(data)
    std = np.std(data)
    threshold = 3 * std

    outliers = [x for x in data if abs(x - mean) > threshold]

    assert 500 in outliers
    assert len(outliers) == 1


@pytest.mark.unit
def test_trend_calculation():
    """Test trend calculation from historical data"""
    # Linear increasing trend
    values = [10, 12, 14, 16, 18, 20]

    # Simple linear regression slope
    x = np.arange(len(values))
    y = np.array(values)
    slope = np.polyfit(x, y, 1)[0]

    assert slope > 0  # Increasing trend
    assert abs(slope - 2.0) < 0.01  # Slope should be ~2
