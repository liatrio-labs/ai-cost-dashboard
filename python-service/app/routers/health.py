"""
Health check and monitoring endpoints.

Provides detailed system health information including database,
scheduler, and external API connectivity.
"""

from fastapi import APIRouter, HTTPException
from datetime import datetime
from typing import Optional
import logging
import psutil
import os
import time

from app.utils.supabase_client import get_supabase_client

router = APIRouter()
logger = logging.getLogger(__name__)

# Store service start time
SERVICE_START_TIME = time.time()


@router.get("/health")
async def health_check():
    """
    Basic health check endpoint to verify service is running.

    Returns:
        Service status, version, and timestamp
    """
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "ai-cost-dashboard-backend",
        "version": "1.0.0"
    }


@router.get("/health/detailed")
async def detailed_health_check():
    """
    Comprehensive health check with all service dependencies.

    Returns:
        Detailed health status including:
        - Overall service health
        - Database connectivity
        - Scheduler status
        - System resources
        - Uptime

    Status:
        - healthy: All systems operational
        - degraded: Some non-critical services down
        - unhealthy: Critical services unavailable
    """
    health_status = {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "ai-cost-dashboard-backend",
        "version": "1.0.0",
        "checks": {}
    }

    # Check database
    db_check = await _check_database()
    health_status["checks"]["database"] = db_check

    # Check scheduler
    scheduler_check = _check_scheduler()
    health_status["checks"]["scheduler"] = scheduler_check

    # Check system resources
    system_check = _check_system_resources()
    health_status["checks"]["system"] = system_check

    # Add uptime
    uptime_seconds = time.time() - SERVICE_START_TIME
    health_status["uptime_seconds"] = round(uptime_seconds, 2)
    health_status["uptime_human"] = _format_uptime(uptime_seconds)

    # Determine overall status
    if not db_check["healthy"]:
        health_status["status"] = "unhealthy"
    elif not scheduler_check["healthy"]:
        health_status["status"] = "degraded"

    return health_status


@router.get("/health/db")
async def database_health():
    """
    Check database connectivity by performing a simple query.

    Returns:
        Database status and connection info

    Raises:
        HTTPException: If database connection fails
    """
    try:
        supabase = get_supabase_client()

        # Start timing
        start_time = time.time()

        # Perform a simple query to verify connection
        response = supabase.from_("users").select("count", count="exact").limit(1).execute()

        # Calculate query time
        query_time_ms = (time.time() - start_time) * 1000

        return {
            "status": "healthy",
            "database": "connected",
            "timestamp": datetime.utcnow().isoformat(),
            "response_time_ms": round(query_time_ms, 2)
        }
    except Exception as e:
        logger.error(f"Database health check failed: {str(e)}")
        raise HTTPException(
            status_code=503,
            detail=f"Database connection failed: {str(e)}"
        )


@router.get("/health/scheduler")
async def scheduler_health():
    """
    Check scheduler status.

    Returns:
        Scheduler status and job information
    """
    from app.utils.scheduler import get_scheduler_status

    try:
        status = get_scheduler_status()
        return {
            "status": "healthy" if status.get("running") else "unhealthy",
            "timestamp": datetime.utcnow().isoformat(),
            **status
        }
    except Exception as e:
        logger.error(f"Scheduler health check failed: {str(e)}")
        return {
            "status": "unknown",
            "timestamp": datetime.utcnow().isoformat(),
            "error": str(e)
        }


@router.get("/metrics")
async def metrics():
    """
    Expose key metrics for monitoring.

    Returns:
        System and application metrics including:
        - Request counts
        - Error rates
        - System resources
        - Data collection statistics
    """
    metrics_data = {
        "timestamp": datetime.utcnow().isoformat(),
        "service": "ai-cost-dashboard-backend",
        "system": _get_system_metrics(),
        "application": await _get_application_metrics()
    }

    return metrics_data


async def _check_database() -> dict:
    """
    Check database connectivity.

    Returns:
        Database health status
    """
    try:
        supabase = get_supabase_client()
        start_time = time.time()

        # Simple query
        supabase.from_("users").select("count", count="exact").limit(1).execute()

        response_time_ms = (time.time() - start_time) * 1000

        return {
            "healthy": True,
            "response_time_ms": round(response_time_ms, 2),
            "message": "Database connected"
        }
    except Exception as e:
        logger.error(f"Database check failed: {str(e)}")
        return {
            "healthy": False,
            "error": str(e),
            "message": "Database connection failed"
        }


def _check_scheduler() -> dict:
    """
    Check scheduler status.

    Returns:
        Scheduler health status
    """
    try:
        from app.utils.scheduler import get_scheduler_status

        status = get_scheduler_status()
        return {
            "healthy": status.get("running", False),
            "jobs": status.get("jobs", []),
            "message": "Scheduler running" if status.get("running") else "Scheduler not running"
        }
    except Exception as e:
        logger.error(f"Scheduler check failed: {str(e)}")
        return {
            "healthy": False,
            "error": str(e),
            "message": "Scheduler check failed"
        }


def _check_system_resources() -> dict:
    """
    Check system resource usage.

    Returns:
        System resource metrics
    """
    try:
        cpu_percent = psutil.cpu_percent(interval=0.1)
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage('/')

        return {
            "healthy": True,
            "cpu_percent": cpu_percent,
            "memory_percent": memory.percent,
            "memory_available_mb": round(memory.available / (1024 * 1024), 2),
            "disk_percent": disk.percent,
            "disk_free_gb": round(disk.free / (1024 * 1024 * 1024), 2)
        }
    except Exception as e:
        logger.error(f"System resource check failed: {str(e)}")
        return {
            "healthy": False,
            "error": str(e)
        }


def _get_system_metrics() -> dict:
    """
    Get system resource metrics.

    Returns:
        System metrics dictionary
    """
    try:
        process = psutil.Process(os.getpid())

        return {
            "cpu_percent": psutil.cpu_percent(interval=0.1),
            "memory_percent": psutil.virtual_memory().percent,
            "memory_used_mb": round(process.memory_info().rss / (1024 * 1024), 2),
            "threads": process.num_threads(),
            "open_files": len(process.open_files())
        }
    except Exception as e:
        logger.error(f"Failed to get system metrics: {str(e)}")
        return {"error": str(e)}


async def _get_application_metrics() -> dict:
    """
    Get application-specific metrics.

    Returns:
        Application metrics dictionary
    """
    try:
        supabase = get_supabase_client()

        # Get count of cost records (last 24 hours)
        from datetime import timedelta
        yesterday = datetime.utcnow() - timedelta(days=1)

        response = supabase.from_("cost_records").select(
            "count", count="exact"
        ).gte("timestamp", yesterday.isoformat()).execute()

        records_24h = response.count if response.count else 0

        return {
            "cost_records_24h": records_24h,
            # Add more metrics as needed
        }
    except Exception as e:
        logger.error(f"Failed to get application metrics: {str(e)}")
        return {"error": str(e)}


def _format_uptime(seconds: float) -> str:
    """
    Format uptime in human-readable format.

    Args:
        seconds: Uptime in seconds

    Returns:
        Formatted uptime string
    """
    days = int(seconds // 86400)
    hours = int((seconds % 86400) // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)

    parts = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0:
        parts.append(f"{hours}h")
    if minutes > 0:
        parts.append(f"{minutes}m")
    parts.append(f"{secs}s")

    return " ".join(parts)
