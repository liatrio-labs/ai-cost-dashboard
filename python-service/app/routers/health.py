"""Health check endpoints."""

from fastapi import APIRouter, HTTPException
from datetime import datetime
import logging

from app.utils.supabase_client import get_supabase_client

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/health")
async def health_check():
    """
    Health check endpoint to verify service is running.
    Returns basic service status and timestamp.
    """
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "ai-cost-dashboard-backend"
    }


@router.get("/health/db")
async def database_health():
    """
    Check database connectivity by performing a simple query.
    Returns database status and connection info.
    """
    try:
        supabase = get_supabase_client()

        # Perform a simple query to verify connection
        response = supabase.from_("users").select("count", count="exact").limit(1).execute()

        return {
            "status": "healthy",
            "database": "connected",
            "timestamp": datetime.utcnow().isoformat()
        }
    except Exception as e:
        logger.error(f"Database health check failed: {str(e)}")
        raise HTTPException(
            status_code=503,
            detail=f"Database connection failed: {str(e)}"
        )
