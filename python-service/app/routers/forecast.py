"""
FastAPI router for cost forecasting endpoints.

Provides endpoints for generating, retrieving, and managing cost forecasts
using the Prophet ML model.
"""

import logging
from datetime import date, datetime
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from app.forecasting.prophet_model import CostForecaster, InsufficientDataError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/forecast", tags=["forecast"])


# ============================================================================
# Pydantic Models
# ============================================================================

class ForecastRequest(BaseModel):
    """Request model for generating forecasts."""

    user_id: str = Field(..., description="User UUID")
    provider_id: Optional[str] = Field(None, description="Optional provider UUID to filter by")
    days: int = Field(30, ge=1, le=90, description="Number of days to forecast (1-90)")
    save_to_db: bool = Field(True, description="Whether to save forecasts to database")

    @field_validator("user_id", "provider_id")
    @classmethod
    def validate_uuid(cls, v: Optional[str]) -> Optional[str]:
        """Validate UUID format."""
        if v is None:
            return v
        try:
            UUID(v)
            return v
        except ValueError:
            raise ValueError(f"Invalid UUID format: {v}")


class ForecastDataPoint(BaseModel):
    """Single forecast data point."""

    date: date = Field(..., description="Forecast date")
    predicted_cost: float = Field(..., description="Predicted cost in USD", ge=0)
    lower_bound_80: float = Field(..., description="Lower bound of 80% confidence interval", ge=0)
    upper_bound_80: float = Field(..., description="Upper bound of 80% confidence interval", ge=0)
    lower_bound_95: float = Field(..., description="Lower bound of 95% confidence interval", ge=0)
    upper_bound_95: float = Field(..., description="Upper bound of 95% confidence interval", ge=0)
    provider_id: Optional[str] = Field(None, description="Provider UUID")


class ForecastResponse(BaseModel):
    """Response model for forecast generation."""

    success: bool = Field(..., description="Whether the operation was successful")
    message: str = Field(..., description="Status message")
    forecasts: List[ForecastDataPoint] = Field(default_factory=list, description="Forecast data points")
    metadata: dict = Field(default_factory=dict, description="Training and model metadata")


class TrainingMetadata(BaseModel):
    """Training metadata response."""

    providers: List[str] = Field(..., description="List of provider IDs trained")
    models_trained: int = Field(..., description="Number of models successfully trained")
    record_count: int = Field(..., description="Total records used for training")
    training_period: dict = Field(..., description="Training data date range")


class HealthCheckResponse(BaseModel):
    """Health check response."""

    status: str = Field(..., description="Service status")
    model_version: str = Field(..., description="Prophet model version")
    min_training_days: int = Field(..., description="Minimum days of data required")


# ============================================================================
# Endpoints
# ============================================================================

@router.get("/health", response_model=HealthCheckResponse)
async def forecast_health_check():
    """
    Health check endpoint for forecasting service.

    Returns:
        Service health status and configuration
    """
    return HealthCheckResponse(
        status="healthy",
        model_version=CostForecaster.MODEL_VERSION,
        min_training_days=CostForecaster.MIN_TRAINING_DAYS
    )


@router.post("/generate", response_model=ForecastResponse, status_code=status.HTTP_201_CREATED)
async def generate_forecast(request: ForecastRequest):
    """
    Generate new cost forecasts using Prophet ML model.

    This endpoint:
    1. Fetches historical cost data for the user
    2. Trains Prophet model(s) on historical data
    3. Generates forecasts for the specified number of days
    4. Optionally saves forecasts to the database

    Args:
        request: Forecast generation request

    Returns:
        Generated forecasts with confidence intervals and metadata

    Raises:
        HTTPException: If insufficient data or other errors occur
    """
    try:
        logger.info(
            f"Generating forecast for user {request.user_id}, "
            f"provider: {request.provider_id or 'all'}, days: {request.days}"
        )

        # Initialize forecaster
        forecaster = CostForecaster(user_id=request.user_id)

        # Train and generate forecasts
        forecast_df, training_metadata = forecaster.train_and_forecast(
            forecast_days=request.days,
            provider_id=request.provider_id,
            save_to_db=request.save_to_db
        )

        # Convert DataFrame to response model
        forecasts = [
            ForecastDataPoint(
                date=row["date"],
                predicted_cost=row["predicted_cost"],
                lower_bound_80=row["lower_bound_80"],
                upper_bound_80=row["upper_bound_80"],
                lower_bound_95=row["lower_bound_95"],
                upper_bound_95=row["upper_bound_95"],
                provider_id=row["provider_id"]
            )
            for _, row in forecast_df.iterrows()
        ]

        logger.info(
            f"Successfully generated {len(forecasts)} forecast points for user {request.user_id}"
        )

        return ForecastResponse(
            success=True,
            message=f"Successfully generated {request.days}-day forecast",
            forecasts=forecasts,
            metadata=training_metadata
        )

    except InsufficientDataError as e:
        logger.warning(f"Insufficient data for forecast: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "insufficient_data",
                "message": str(e),
                "min_days_required": CostForecaster.MIN_TRAINING_DAYS
            }
        )

    except ValueError as e:
        logger.error(f"Validation error in forecast generation: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "validation_error",
                "message": str(e)
            }
        )

    except Exception as e:
        logger.error(f"Unexpected error generating forecast: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "internal_error",
                "message": "Failed to generate forecast. Please try again later."
            }
        )


@router.get("/latest", response_model=ForecastResponse)
async def get_latest_forecast(
    user_id: str = Query(..., description="User UUID"),
    provider_id: Optional[str] = Query(None, description="Optional provider UUID to filter by"),
    days: int = Query(30, ge=1, le=90, description="Number of days of forecasts to retrieve")
):
    """
    Retrieve the most recent forecasts from the database.

    This endpoint retrieves previously generated forecasts without
    retraining the model, making it much faster than /generate.

    Args:
        user_id: User UUID
        provider_id: Optional provider UUID to filter by
        days: Number of days of forecasts to retrieve

    Returns:
        Most recent forecasts for the specified period

    Raises:
        HTTPException: If no forecasts are found or other errors occur
    """
    try:
        # Validate UUIDs
        try:
            UUID(user_id)
            if provider_id:
                UUID(provider_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "validation_error", "message": "Invalid UUID format"}
            )

        logger.info(
            f"Retrieving latest forecasts for user {user_id}, "
            f"provider: {provider_id or 'all'}, days: {days}"
        )

        # Initialize forecaster
        forecaster = CostForecaster(user_id=user_id)

        # Retrieve forecasts
        forecast_df = forecaster.get_latest_forecasts(
            provider_id=provider_id,
            days=days
        )

        if forecast_df.empty:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "error": "not_found",
                    "message": "No forecasts found. Generate forecasts using /generate endpoint first."
                }
            )

        # Convert DataFrame to response model
        forecasts = [
            ForecastDataPoint(
                date=row["forecast_date"].date(),
                predicted_cost=float(row["predicted_cost_usd"]),
                lower_bound_80=float(row["lower_bound_80"]),
                upper_bound_80=float(row["upper_bound_80"]),
                lower_bound_95=float(row["lower_bound_95"]),
                upper_bound_95=float(row["upper_bound_95"]),
                provider_id=row["provider_id"]
            )
            for _, row in forecast_df.iterrows()
        ]

        # Extract metadata from first record
        metadata = {}
        if not forecast_df.empty:
            first_row = forecast_df.iloc[0]
            metadata = {
                "model_version": first_row.get("model_version"),
                "training_period": {
                    "start": first_row.get("training_data_start"),
                    "end": first_row.get("training_data_end")
                },
                "training_record_count": first_row.get("training_record_count"),
                "generated_at": first_row.get("created_at")
            }

        logger.info(f"Retrieved {len(forecasts)} forecast points for user {user_id}")

        return ForecastResponse(
            success=True,
            message=f"Retrieved {days}-day forecast",
            forecasts=forecasts,
            metadata=metadata
        )

    except HTTPException:
        raise

    except Exception as e:
        logger.error(f"Unexpected error retrieving forecasts: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "internal_error",
                "message": "Failed to retrieve forecasts. Please try again later."
            }
        )


@router.post("/train", response_model=dict, status_code=status.HTTP_200_OK)
async def train_models(
    user_id: str = Query(..., description="User UUID"),
    provider_id: Optional[str] = Query(None, description="Optional provider UUID to train specific model")
):
    """
    Train Prophet models without generating forecasts.

    This endpoint is useful for pre-training models or testing model training
    without actually generating forecast predictions.

    Args:
        user_id: User UUID
        provider_id: Optional provider UUID to train specific model

    Returns:
        Training metadata and statistics

    Raises:
        HTTPException: If insufficient data or other errors occur
    """
    try:
        # Validate UUIDs
        try:
            UUID(user_id)
            if provider_id:
                UUID(provider_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "validation_error", "message": "Invalid UUID format"}
            )

        logger.info(f"Training models for user {user_id}, provider: {provider_id or 'all'}")

        # Initialize forecaster
        forecaster = CostForecaster(user_id=user_id)

        # Train models
        training_metadata = forecaster.train(provider_id=provider_id)

        logger.info(
            f"Successfully trained {training_metadata['models_trained']} models for user {user_id}"
        )

        return {
            "success": True,
            "message": "Models trained successfully",
            "metadata": training_metadata
        }

    except InsufficientDataError as e:
        logger.warning(f"Insufficient data for training: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "insufficient_data",
                "message": str(e),
                "min_days_required": CostForecaster.MIN_TRAINING_DAYS
            }
        )

    except ValueError as e:
        logger.error(f"Validation error in model training: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "validation_error",
                "message": str(e)
            }
        )

    except Exception as e:
        logger.error(f"Unexpected error training models: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "internal_error",
                "message": "Failed to train models. Please try again later."
            }
        )
