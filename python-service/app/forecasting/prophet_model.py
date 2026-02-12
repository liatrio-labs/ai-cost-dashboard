"""
Facebook Prophet-based cost forecasting model.

This module implements ML-based cost forecasting using Facebook Prophet,
with support for weekly seasonality (workday vs weekend patterns) and
per-provider model training.
"""

import logging
import pickle
from datetime import datetime, timedelta, date
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from uuid import UUID

import pandas as pd
import numpy as np
from prophet import Prophet
from prophet.serialize import model_to_json, model_from_json

from app.utils.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


class InsufficientDataError(Exception):
    """Raised when there is insufficient historical data for training."""
    pass


class CostForecaster:
    """
    ML-based cost forecasting using Facebook Prophet.

    Trains separate models per provider and generates 30-day predictions
    with confidence intervals.
    """

    # Minimum number of days of historical data required for training
    MIN_TRAINING_DAYS = 30

    # Default forecast horizon in days
    DEFAULT_FORECAST_DAYS = 30

    # Model version for tracking
    MODEL_VERSION = "prophet-v1.0"

    def __init__(self, user_id: str):
        """
        Initialize the CostForecaster.

        Args:
            user_id: UUID of the user for whom to generate forecasts
        """
        self.user_id = user_id
        self.supabase = get_supabase_client()
        self.models: Dict[str, Prophet] = {}  # provider_id -> model
        self.training_metadata: Dict[str, Dict] = {}  # provider_id -> metadata

    def _configure_prophet(self) -> Prophet:
        """
        Configure Prophet model with appropriate settings.

        Returns:
            Configured Prophet model instance
        """
        model = Prophet(
            yearly_seasonality=False,
            weekly_seasonality=True,  # Capture workday vs weekend patterns
            daily_seasonality=False,
            changepoint_prior_scale=0.05,  # Conservative for cost data
            interval_width=0.95,  # Generate 95% confidence intervals
            uncertainty_samples=1000
        )
        return model

    def _fetch_historical_data(
        self,
        provider_id: Optional[str] = None
    ) -> pd.DataFrame:
        """
        Fetch historical cost data from Supabase.

        Args:
            provider_id: Optional provider ID to filter by. If None, fetches all providers.

        Returns:
            DataFrame with columns: ds (date), y (cost), provider_id

        Raises:
            InsufficientDataError: If insufficient data is available
        """
        try:
            # Build query
            query = self.supabase.table("cost_records").select(
                "timestamp, cost_usd, provider_id"
            ).eq("user_id", self.user_id)

            if provider_id:
                query = query.eq("provider_id", provider_id)

            # Fetch data
            response = query.execute()

            if not response.data:
                raise InsufficientDataError(
                    f"No historical data found for user {self.user_id}"
                )

            # Convert to DataFrame
            df = pd.DataFrame(response.data)

            # Convert timestamp to datetime and aggregate by day
            df["timestamp"] = pd.to_datetime(df["timestamp"])
            df["date"] = df["timestamp"].dt.date

            # Aggregate costs by day and provider
            daily_costs = df.groupby(["date", "provider_id"])["cost_usd"].sum().reset_index()
            daily_costs.columns = ["ds", "provider_id", "y"]

            # Convert ds to datetime
            daily_costs["ds"] = pd.to_datetime(daily_costs["ds"])

            # Check if we have enough data
            min_date = daily_costs["ds"].min()
            max_date = daily_costs["ds"].max()
            days_of_data = (max_date - min_date).days + 1

            if days_of_data < self.MIN_TRAINING_DAYS:
                raise InsufficientDataError(
                    f"Insufficient data: {days_of_data} days available, "
                    f"{self.MIN_TRAINING_DAYS} days required"
                )

            logger.info(
                f"Fetched {len(daily_costs)} daily records spanning {days_of_data} days "
                f"for user {self.user_id}"
            )

            return daily_costs

        except Exception as e:
            logger.error(f"Error fetching historical data: {str(e)}")
            raise

    def _handle_missing_dates(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Handle missing dates in the time series by filling with zeros.

        Args:
            df: DataFrame with ds (date) and y (cost) columns

        Returns:
            DataFrame with all dates filled in
        """
        # Create complete date range
        min_date = df["ds"].min()
        max_date = df["ds"].max()
        all_dates = pd.date_range(start=min_date, end=max_date, freq="D")

        # Create complete DataFrame
        complete_df = pd.DataFrame({"ds": all_dates})

        # Merge with original data, filling missing values with 0
        complete_df = complete_df.merge(df, on="ds", how="left")
        complete_df["y"] = complete_df["y"].fillna(0)

        # Preserve provider_id if present
        if "provider_id" in df.columns:
            complete_df["provider_id"] = df["provider_id"].iloc[0]

        return complete_df

    def train(
        self,
        provider_id: Optional[str] = None,
        save_model: bool = True
    ) -> Dict[str, any]:
        """
        Train Prophet model(s) on historical cost data.

        If provider_id is specified, trains a single model for that provider.
        Otherwise, trains separate models for each provider.

        Args:
            provider_id: Optional provider ID to train model for specific provider
            save_model: Whether to save the trained model for later use

        Returns:
            Dictionary with training metadata including:
            - providers: list of provider IDs trained
            - training_period: start and end dates
            - record_count: number of records used
            - changepoints_detected: number of changepoints found

        Raises:
            InsufficientDataError: If insufficient training data is available
        """
        logger.info(f"Starting model training for user {self.user_id}")

        # Fetch historical data
        historical_data = self._fetch_historical_data(provider_id)

        # Get unique providers
        if provider_id:
            provider_ids = [provider_id]
        else:
            provider_ids = historical_data["provider_id"].unique().tolist()

        training_results = {
            "providers": [],
            "training_period": {},
            "record_count": 0,
            "models_trained": 0
        }

        # Train model for each provider
        for pid in provider_ids:
            try:
                # Filter data for this provider
                provider_data = historical_data[
                    historical_data["provider_id"] == pid
                ][["ds", "y"]].copy()

                # Handle missing dates
                provider_data = self._handle_missing_dates(provider_data)

                # Configure and train model
                model = self._configure_prophet()

                logger.info(f"Training model for provider {pid} with {len(provider_data)} days of data")
                model.fit(provider_data)

                # Store model
                self.models[pid] = model

                # Store training metadata
                self.training_metadata[pid] = {
                    "provider_id": pid,
                    "training_start": provider_data["ds"].min().date().isoformat(),
                    "training_end": provider_data["ds"].max().date().isoformat(),
                    "record_count": len(provider_data),
                    "changepoints": len(model.changepoints),
                    "trained_at": datetime.utcnow().isoformat()
                }

                training_results["providers"].append(pid)
                training_results["record_count"] += len(provider_data)
                training_results["models_trained"] += 1

                logger.info(
                    f"Successfully trained model for provider {pid}. "
                    f"Detected {len(model.changepoints)} changepoints."
                )

            except Exception as e:
                logger.error(f"Error training model for provider {pid}: {str(e)}")
                # Continue with other providers
                continue

        if not self.models:
            raise InsufficientDataError("No models could be trained")

        # Set training period from first provider
        first_provider = list(self.training_metadata.values())[0]
        training_results["training_period"] = {
            "start": first_provider["training_start"],
            "end": first_provider["training_end"]
        }

        logger.info(
            f"Training complete. Trained {training_results['models_trained']} models "
            f"across {len(training_results['providers'])} providers."
        )

        return training_results

    def forecast(
        self,
        days: int = DEFAULT_FORECAST_DAYS,
        provider_id: Optional[str] = None
    ) -> pd.DataFrame:
        """
        Generate cost forecasts for the specified number of days.

        Args:
            days: Number of days to forecast (default: 30)
            provider_id: Optional provider ID to forecast for specific provider

        Returns:
            DataFrame with columns:
            - provider_id: Provider UUID
            - date: Forecast date
            - predicted_cost: Predicted cost in USD
            - lower_bound_80: Lower bound of 80% confidence interval
            - upper_bound_80: Upper bound of 80% confidence interval
            - lower_bound_95: Lower bound of 95% confidence interval
            - upper_bound_95: Upper bound of 95% confidence interval

        Raises:
            ValueError: If models haven't been trained yet
        """
        if not self.models:
            raise ValueError("Models must be trained before forecasting. Call train() first.")

        # Determine which providers to forecast for
        if provider_id:
            if provider_id not in self.models:
                raise ValueError(f"No trained model found for provider {provider_id}")
            provider_ids = [provider_id]
        else:
            provider_ids = list(self.models.keys())

        all_forecasts = []

        # Generate forecasts for each provider
        for pid in provider_ids:
            try:
                model = self.models[pid]

                # Create future DataFrame
                future = model.make_future_dataframe(periods=days, freq="D")

                # Generate predictions
                forecast = model.predict(future)

                # Extract only future predictions (not historical)
                future_forecast = forecast.tail(days).copy()

                # Calculate 80% confidence intervals
                # Prophet provides yhat_lower and yhat_upper which are 95% by default
                # We approximate 80% intervals by scaling the uncertainty
                uncertainty_95 = (future_forecast["yhat_upper"] - future_forecast["yhat_lower"]) / 2
                uncertainty_80 = uncertainty_95 * 0.842  # Scale factor for 80% CI

                # Build result DataFrame
                result = pd.DataFrame({
                    "provider_id": pid,
                    "date": future_forecast["ds"].dt.date,
                    "predicted_cost": future_forecast["yhat"].clip(lower=0),  # No negative costs
                    "lower_bound_80": (future_forecast["yhat"] - uncertainty_80).clip(lower=0),
                    "upper_bound_80": (future_forecast["yhat"] + uncertainty_80).clip(lower=0),
                    "lower_bound_95": future_forecast["yhat_lower"].clip(lower=0),
                    "upper_bound_95": future_forecast["yhat_upper"].clip(lower=0)
                })

                all_forecasts.append(result)

                logger.info(
                    f"Generated {days}-day forecast for provider {pid}. "
                    f"Average predicted cost: ${result['predicted_cost'].mean():.2f}/day"
                )

            except Exception as e:
                logger.error(f"Error generating forecast for provider {pid}: {str(e)}")
                continue

        if not all_forecasts:
            raise ValueError("Failed to generate forecasts for any provider")

        # Combine all forecasts
        combined_forecast = pd.concat(all_forecasts, ignore_index=True)

        return combined_forecast

    def save_forecast_to_db(
        self,
        forecast_df: pd.DataFrame
    ) -> int:
        """
        Save forecast results to the database.

        Args:
            forecast_df: DataFrame with forecast results from forecast() method

        Returns:
            Number of records saved

        Raises:
            Exception: If database operation fails
        """
        try:
            records = []

            for _, row in forecast_df.iterrows():
                provider_id = row["provider_id"]
                metadata = self.training_metadata.get(provider_id, {})

                record = {
                    "user_id": self.user_id,
                    "provider_id": provider_id,
                    "model_name": None,  # Aggregated across all models
                    "forecast_date": row["date"].isoformat(),
                    "predicted_cost_usd": float(row["predicted_cost"]),
                    "lower_bound_80": float(row["lower_bound_80"]),
                    "upper_bound_80": float(row["upper_bound_80"]),
                    "lower_bound_95": float(row["lower_bound_95"]),
                    "upper_bound_95": float(row["upper_bound_95"]),
                    "confidence_score": None,  # Could add model confidence metric
                    "model_version": self.MODEL_VERSION,
                    "training_data_start": metadata.get("training_start"),
                    "training_data_end": metadata.get("training_end"),
                    "training_record_count": metadata.get("record_count", 0),
                    "metadata": {
                        "changepoints": metadata.get("changepoints", 0),
                        "trained_at": metadata.get("trained_at")
                    }
                }

                records.append(record)

            # Insert records into Supabase
            response = self.supabase.table("forecast_results").insert(records).execute()

            logger.info(f"Successfully saved {len(records)} forecast records to database")

            return len(records)

        except Exception as e:
            logger.error(f"Error saving forecast to database: {str(e)}")
            raise

    def train_and_forecast(
        self,
        forecast_days: int = DEFAULT_FORECAST_DAYS,
        provider_id: Optional[str] = None,
        save_to_db: bool = True
    ) -> Tuple[pd.DataFrame, Dict]:
        """
        Convenience method to train models and generate forecasts in one call.

        Args:
            forecast_days: Number of days to forecast
            provider_id: Optional provider ID to limit to specific provider
            save_to_db: Whether to save forecasts to database

        Returns:
            Tuple of (forecast DataFrame, training metadata)
        """
        # Train models
        training_metadata = self.train(provider_id=provider_id)

        # Generate forecasts
        forecast_df = self.forecast(days=forecast_days, provider_id=provider_id)

        # Save to database if requested
        if save_to_db:
            self.save_forecast_to_db(forecast_df)

        return forecast_df, training_metadata

    def get_latest_forecasts(
        self,
        provider_id: Optional[str] = None,
        days: int = 30
    ) -> pd.DataFrame:
        """
        Retrieve the most recent forecasts from the database.

        Args:
            provider_id: Optional provider ID to filter by
            days: Number of days of forecasts to retrieve

        Returns:
            DataFrame with forecast data
        """
        try:
            # Calculate date range
            start_date = date.today()
            end_date = start_date + timedelta(days=days)

            # Build query
            query = self.supabase.table("forecast_results").select("*").eq(
                "user_id", self.user_id
            ).gte("forecast_date", start_date.isoformat()).lte(
                "forecast_date", end_date.isoformat()
            ).order("created_at", desc=True)

            if provider_id:
                query = query.eq("provider_id", provider_id)

            response = query.execute()

            if not response.data:
                return pd.DataFrame()

            df = pd.DataFrame(response.data)

            # Keep only the most recent forecast for each date/provider combination
            df["forecast_date"] = pd.to_datetime(df["forecast_date"])
            df = df.sort_values("created_at", ascending=False)
            df = df.drop_duplicates(subset=["provider_id", "forecast_date"], keep="first")

            return df.sort_values("forecast_date")

        except Exception as e:
            logger.error(f"Error retrieving forecasts from database: {str(e)}")
            raise
