"""
Data collection endpoints.

Collection uses org-level API keys from environment secrets and attributes all
records to a single owner user (see app.collectors.runner). There is no
per-user credential storage or decryption in this path.
"""

import os
import logging

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.collectors.runner import COLLECTORS, run_collection_for_provider
from app.utils.supabase_client import get_supabase_client

router = APIRouter(prefix="/api/collection", tags=["collection"])
logger = logging.getLogger(__name__)


def verify_trigger_secret(authorization: str = Header(default="")) -> None:
    """
    Authenticate scheduler/cron callers (e.g. Vercel Cron) via a shared secret.

    Expects ``Authorization: Bearer <secret>`` matching COLLECTION_TRIGGER_SECRET
    (falls back to CRON_SECRET so the same value can be shared with the Vercel
    cron routes).
    """
    secret = os.environ.get("COLLECTION_TRIGGER_SECRET") or os.environ.get("CRON_SECRET")
    if not secret:
        raise HTTPException(
            status_code=500,
            detail="Collection trigger secret is not configured on the server",
        )
    if authorization != f"Bearer {secret}":
        raise HTTPException(status_code=401, detail="Unauthorized")


class RunAllRequest(BaseModel):
    """Request model for triggering collection of a provider."""
    provider: str = Field(..., description=f"Provider name (one of: {', '.join(COLLECTORS)})")
    backfill: bool = Field(default=False, description="Whether to backfill historical data")
    backfill_days: int = Field(default=90, description="Number of days to backfill (if backfill=True)")


@router.post("/run-all", dependencies=[Depends(verify_trigger_secret)])
async def run_all_collection(request: RunAllRequest):
    """
    Trigger collection for a provider using its env-configured org key.

    Authenticated via the COLLECTION_TRIGGER_SECRET / CRON_SECRET bearer token.
    This is the endpoint invoked by the Vercel Cron routes for daily collection.
    Returns a structured summary (status may be success / skipped / error).
    """
    logger.info(
        f"Scheduled collection triggered for provider={request.provider}, "
        f"backfill={request.backfill}"
    )
    return await run_collection_for_provider(
        provider_name=request.provider,
        backfill=request.backfill,
        backfill_days=request.backfill_days,
    )


@router.get("/status/{provider}")
async def get_collection_status(provider: str):
    """
    Return the latest collection status for a provider (shared/owner data).
    """
    if provider not in COLLECTORS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported provider. Supported: {', '.join(COLLECTORS)}",
        )

    try:
        supabase = get_supabase_client()
        provider_response = (
            supabase.from_("providers").select("id").eq("name", provider).single().execute()
        )
        if not provider_response.data:
            raise HTTPException(status_code=404, detail=f"Provider '{provider}' not found")
        provider_id = provider_response.data["id"]

        latest = (
            supabase.from_("cost_records")
            .select("timestamp, created_at, model_name, cost_usd")
            .eq("provider_id", provider_id)
            .order("timestamp", desc=True)
            .limit(1)
            .execute()
        )
        if not latest.data:
            return {"provider": provider, "status": "no_data", "message": "No data collected yet"}

        record = latest.data[0]
        count_response = (
            supabase.from_("cost_records")
            .select("count", count="exact")
            .eq("provider_id", provider_id)
            .execute()
        )
        return {
            "provider": provider,
            "status": "active",
            "last_collection_timestamp": record["timestamp"],
            "last_collection_created_at": record["created_at"],
            "total_records": count_response.count,
            "latest_model": record["model_name"],
            "latest_cost": float(record["cost_usd"]),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get collection status: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get status: {str(e)}")
