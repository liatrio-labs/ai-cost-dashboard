"""Scheduler management endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any
import logging

from app.utils.scheduler import get_scheduler

router = APIRouter(prefix="/api/scheduler", tags=["scheduler"])
logger = logging.getLogger(__name__)


class JobTriggerRequest(BaseModel):
    """Request model for manual job triggering."""
    job_id: str


class JobTriggerResponse(BaseModel):
    """Response model for job trigger operations."""
    status: str
    job_id: str
    message: Optional[str] = None
    error: Optional[str] = None


@router.get("/status")
async def get_scheduler_status():
    """
    Get current scheduler status.

    Returns scheduler state, configured jobs, and recent execution history.
    Useful for monitoring and debugging.

    Returns:
        Scheduler status with jobs and history
    """
    try:
        scheduler = get_scheduler()
        status = scheduler.get_status()

        return {
            "status": "healthy" if status["running"] else "stopped",
            "scheduler": status
        }

    except Exception as e:
        logger.error(f"Failed to get scheduler status: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get status: {str(e)}")


@router.get("/jobs")
async def list_jobs():
    """
    List all scheduled jobs.

    Returns:
        List of jobs with their schedules and next run times
    """
    try:
        scheduler = get_scheduler()
        status = scheduler.get_status()

        return {
            "jobs": status["jobs"],
            "timezone": status["timezone"]
        }

    except Exception as e:
        logger.error(f"Failed to list jobs: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to list jobs: {str(e)}")


@router.get("/jobs/{job_id}")
async def get_job_details(job_id: str):
    """
    Get details for a specific job.

    Args:
        job_id: Job identifier (e.g., "anthropic_collection", "openai_collection")

    Returns:
        Job details including schedule and recent history
    """
    try:
        scheduler = get_scheduler()
        status = scheduler.get_status()

        # Find the job
        job = next((j for j in status["jobs"] if j["id"] == job_id), None)

        if not job:
            raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

        # Get recent history for this job
        history = status["job_history"].get(job_id, [])

        return {
            "job": job,
            "recent_history": history[-10:]  # Last 10 executions
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get job details: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get job details: {str(e)}")


@router.post("/jobs/{job_id}/trigger", response_model=JobTriggerResponse)
async def trigger_job(job_id: str):
    """
    Manually trigger a scheduled job.

    This endpoint allows manual execution of any scheduled job,
    useful for testing, debugging, or on-demand data collection.

    Available jobs:
    - `anthropic_collection`: Collect Anthropic data for all users
    - `openai_collection`: Collect OpenAI data for all users
    - `aggregate_refresh`: Refresh materialized views
    - `forecasting`: Run ML forecasting (when implemented)

    Args:
        job_id: Job identifier to trigger

    Returns:
        JobTriggerResponse with execution result
    """
    try:
        scheduler = get_scheduler()

        logger.info(f"Manual trigger requested for job: {job_id}")

        result = await scheduler.trigger_job_manually(job_id)

        return JobTriggerResponse(
            status=result["status"],
            job_id=result["job_id"],
            message=result.get("message"),
            error=result.get("error")
        )

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to trigger job: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to trigger job: {str(e)}")


@router.get("/health")
async def scheduler_health():
    """
    Scheduler health check endpoint.

    Returns health status and basic scheduler info.
    Designed for monitoring systems and health probes.

    Returns:
        Health status with scheduler state
    """
    try:
        scheduler = get_scheduler()
        status = scheduler.get_status()

        if not status["running"]:
            raise HTTPException(
                status_code=503,
                detail="Scheduler is not running"
            )

        return {
            "status": "healthy",
            "scheduler_running": True,
            "job_count": len(status["jobs"]),
            "timezone": status["timezone"]
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Scheduler health check failed: {str(e)}")
        raise HTTPException(
            status_code=503,
            detail=f"Scheduler health check failed: {str(e)}"
        )


@router.get("/history")
async def get_job_history(limit: int = 50):
    """
    Get recent job execution history across all jobs.

    Args:
        limit: Maximum number of history entries per job (default: 50, max: 100)

    Returns:
        Job execution history with timestamps and status
    """
    try:
        if limit > 100:
            limit = 100

        scheduler = get_scheduler()
        status = scheduler.get_status()

        # Get history for all jobs, limited per job
        history_summary = {}
        for job_id, history in status["job_history"].items():
            history_summary[job_id] = history[-limit:]

        return {
            "job_history": history_summary,
            "total_jobs": len(history_summary)
        }

    except Exception as e:
        logger.error(f"Failed to get job history: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get history: {str(e)}")


@router.get("/next-runs")
async def get_next_runs():
    """
    Get next scheduled run times for all jobs.

    Useful for understanding when the next data collection will occur.

    Returns:
        Next run times for each job
    """
    try:
        scheduler = get_scheduler()
        status = scheduler.get_status()

        next_runs = {}
        for job in status["jobs"]:
            next_runs[job["id"]] = {
                "name": job["name"],
                "next_run": job["next_run"],
                "trigger": job["trigger"]
            }

        return {
            "next_runs": next_runs,
            "timezone": status["timezone"]
        }

    except Exception as e:
        logger.error(f"Failed to get next runs: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get next runs: {str(e)}")
