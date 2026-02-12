"""Data collection endpoints for manual triggering."""

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timedelta
import logging

from app.collectors.anthropic_collector import AnthropicCollector
from app.utils.supabase_client import get_supabase_client

router = APIRouter(prefix="/api/collection", tags=["collection"])
logger = logging.getLogger(__name__)


class CollectionRequest(BaseModel):
    """Request model for manual collection trigger."""
    provider: str = Field(..., description="Provider name (anthropic, openai)")
    user_id: str = Field(..., description="User ID who owns the API key")
    backfill: bool = Field(default=False, description="Whether to backfill historical data")
    backfill_days: int = Field(default=90, description="Number of days to backfill (if backfill=True)")


class CollectionResponse(BaseModel):
    """Response model for collection operations."""
    status: str
    provider: str
    records_collected: int
    records_stored: int
    timestamp: str
    error: Optional[str] = None


async def get_provider_credentials(user_id: str, provider_name: str) -> tuple[str, str]:
    """
    Retrieve API credentials for a user and provider.

    Args:
        user_id: User ID
        provider_name: Provider name (anthropic, openai)

    Returns:
        Tuple of (api_key, provider_id)

    Raises:
        HTTPException: If credentials not found or invalid
    """
    try:
        supabase = get_supabase_client()

        # Get provider ID
        provider_response = supabase.from_("providers").select("id").eq("name", provider_name).single().execute()

        if not provider_response.data:
            raise HTTPException(status_code=404, detail=f"Provider '{provider_name}' not found")

        provider_id = provider_response.data["id"]

        # Get user's API credentials for this provider
        creds_response = (
            supabase.from_("api_credentials")
            .select("encrypted_api_key")
            .eq("user_id", user_id)
            .eq("provider_id", provider_id)
            .eq("is_active", True)
            .single()
            .execute()
        )

        if not creds_response.data:
            raise HTTPException(
                status_code=404,
                detail=f"No active API credentials found for user {user_id} and provider {provider_name}"
            )

        # TODO: Decrypt the API key using encryption utility
        # For now, assume keys are stored in plain text (development only)
        api_key = creds_response.data["encrypted_api_key"]

        return api_key, provider_id

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to retrieve credentials: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to retrieve credentials: {str(e)}")


@router.post("/trigger", response_model=CollectionResponse)
async def trigger_collection(request: CollectionRequest):
    """
    Manually trigger data collection for a specific provider and user.

    This endpoint allows manual triggering of data collection, useful for:
    - Testing collector implementation
    - On-demand data refresh
    - Backfilling historical data

    Args:
        request: Collection request with provider and user info

    Returns:
        CollectionResponse with operation results
    """
    logger.info(
        f"Manual collection triggered for provider={request.provider}, "
        f"user={request.user_id}, backfill={request.backfill}"
    )

    try:
        # Get user's API credentials
        api_key, provider_id = await get_provider_credentials(request.user_id, request.provider)

        # Route to appropriate collector
        if request.provider == "anthropic":
            async with AnthropicCollector(
                api_key=api_key,
                user_id=request.user_id,
                provider_id=provider_id
            ) as collector:
                if request.backfill:
                    result = await collector.backfill_historical_data(days=request.backfill_days)
                else:
                    result = await collector.run()

                return CollectionResponse(
                    status=result["status"],
                    provider=result["provider"],
                    records_collected=result.get("records_collected", 0),
                    records_stored=result.get("records_stored", 0),
                    timestamp=result.get("timestamp", datetime.utcnow().isoformat()),
                    error=result.get("error")
                )

        else:
            raise HTTPException(
                status_code=400,
                detail=f"Provider '{request.provider}' not supported yet. Supported: anthropic"
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Collection failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Collection failed: {str(e)}")


@router.get("/status/{provider}")
async def get_collection_status(provider: str, user_id: str):
    """
    Get the last collection status for a provider and user.

    Args:
        provider: Provider name
        user_id: User ID

    Returns:
        Last collection timestamp and record counts
    """
    try:
        supabase = get_supabase_client()

        # Get provider ID
        provider_response = supabase.from_("providers").select("id").eq("name", provider).single().execute()

        if not provider_response.data:
            raise HTTPException(status_code=404, detail=f"Provider '{provider}' not found")

        provider_id = provider_response.data["id"]

        # Get latest record for this user and provider
        latest_record = (
            supabase.from_("cost_records")
            .select("timestamp, created_at, model_name, cost_usd")
            .eq("user_id", user_id)
            .eq("provider_id", provider_id)
            .order("timestamp", desc=True)
            .limit(1)
            .execute()
        )

        if not latest_record.data:
            return {
                "provider": provider,
                "user_id": user_id,
                "status": "no_data",
                "message": "No data collected yet"
            }

        record = latest_record.data[0]

        # Count total records
        count_response = (
            supabase.from_("cost_records")
            .select("count", count="exact")
            .eq("user_id", user_id)
            .eq("provider_id", provider_id)
            .execute()
        )

        return {
            "provider": provider,
            "user_id": user_id,
            "status": "active",
            "last_collection_timestamp": record["timestamp"],
            "last_collection_created_at": record["created_at"],
            "total_records": count_response.count,
            "latest_model": record["model_name"],
            "latest_cost": float(record["cost_usd"])
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get collection status: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get status: {str(e)}")
