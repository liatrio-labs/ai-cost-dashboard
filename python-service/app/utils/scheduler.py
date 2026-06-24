"""
Scheduler for automated data collection and processing jobs.
Uses APScheduler for cron-like scheduling with async support.
"""

import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.events import EVENT_JOB_EXECUTED, EVENT_JOB_ERROR

from app.utils.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


class CollectionScheduler:
    """
    Scheduler for automated data collection and processing jobs.

    Manages scheduled jobs for:
    - Anthropic API data collection (hourly)
    - OpenAI API data collection (every 6 hours)
    - Continuous aggregate refresh (every 15 minutes)
    - ML forecasting (daily at midnight)
    """

    def __init__(self):
        """Initialize the scheduler."""
        self.scheduler = AsyncIOScheduler(timezone=timezone.utc)
        self.job_history: Dict[str, List[Dict[str, Any]]] = {}
        self._setup_event_listeners()
        logger.info("CollectionScheduler initialized")

    def _setup_event_listeners(self):
        """Set up event listeners for job execution tracking."""
        self.scheduler.add_listener(
            self._on_job_executed,
            EVENT_JOB_EXECUTED
        )
        self.scheduler.add_listener(
            self._on_job_error,
            EVENT_JOB_ERROR
        )

    def _on_job_executed(self, event):
        """Handle successful job execution."""
        job_id = event.job_id
        logger.info(f"Job {job_id} executed successfully")

        # Track in history
        if job_id not in self.job_history:
            self.job_history[job_id] = []

        self.job_history[job_id].append({
            "status": "success",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": "executed"
        })

        # Keep only last 100 entries per job
        self.job_history[job_id] = self.job_history[job_id][-100:]

    def _on_job_error(self, event):
        """Handle job execution error."""
        job_id = event.job_id
        exception = event.exception
        logger.error(f"Job {job_id} failed: {str(exception)}")

        # Track in history
        if job_id not in self.job_history:
            self.job_history[job_id] = []

        self.job_history[job_id].append({
            "status": "error",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "error": str(exception),
            "event": "error"
        })

        # Keep only last 100 entries per job
        self.job_history[job_id] = self.job_history[job_id][-100:]

    async def collect_provider(self, provider_name: str):
        """
        Collect a single provider using its env-configured org key (delegates to
        the shared env-driven runner). Imported lazily to avoid import cycles.
        """
        from app.collectors.runner import run_collection_for_provider

        logger.info(f"Starting scheduled collection for {provider_name}")
        result = await run_collection_for_provider(provider_name)
        logger.info(
            f"{provider_name} collection: status={result.get('status')}, "
            f"stored={result.get('records_stored', 0)}"
        )
        return result

    async def refresh_aggregates(self):
        """
        Refresh materialized views for continuous aggregates.
        Runs every 15 minutes for near-real-time dashboard updates.
        """
        logger.info("Starting aggregate refresh")

        try:
            supabase = get_supabase_client()

            # Call the refresh function in the database
            supabase.rpc("refresh_cost_records_daily").execute()

            logger.info("Aggregate refresh completed successfully")

        except Exception as e:
            logger.error(f"Aggregate refresh failed: {str(e)}")
            raise

    async def run_forecasting(self):
        """
        Run ML forecasting for all users.
        Runs daily at midnight UTC.
        Placeholder for task #11 - Prophet forecasting.
        """
        logger.info("Starting forecasting job")

        try:
            # TODO: Implement when task #11 (Prophet forecasting) is complete
            logger.info("Forecasting not yet implemented (pending task #11)")

        except Exception as e:
            logger.error(f"Forecasting job failed: {str(e)}")
            raise

    def schedule_jobs(self):
        """
        Schedule all data collection and processing jobs (fallback path; only
        used when ENABLE_INTERNAL_SCHEDULER is set — Vercel Cron is primary).

        Jobs:
        - One daily collection job per provider (env-keyed), staggered
        - Aggregates: Every 15 minutes
        - Forecasting: Daily
        """
        from app.collectors.runner import COLLECTORS

        # One daily collection job per provider, staggered through the 08:00 hour.
        for index, provider_name in enumerate(COLLECTORS):
            minute = (index * 10) % 60
            self.scheduler.add_job(
                self.collect_provider,
                trigger=CronTrigger(hour=8, minute=minute, timezone=timezone.utc),
                id=f"{provider_name}_collection",
                name=f"{provider_name} Data Collection",
                kwargs={"provider_name": provider_name},
                replace_existing=True,
                max_instances=1,  # Prevent overlapping runs
            )
            logger.info(f"Scheduled {provider_name} collection: daily at 08:{minute:02d} UTC")

        # Aggregate refresh: Every 15 minutes
        self.scheduler.add_job(
            self.refresh_aggregates,
            trigger=IntervalTrigger(minutes=15, timezone=timezone.utc),
            id="aggregate_refresh",
            name="Aggregate Refresh",
            replace_existing=True,
            max_instances=1
        )
        logger.info("Scheduled aggregate refresh: Every 15 minutes")

        # Forecasting: Daily at midnight UTC
        self.scheduler.add_job(
            self.run_forecasting,
            trigger=CronTrigger(hour=0, minute=0, timezone=timezone.utc),
            id="forecasting",
            name="ML Forecasting",
            replace_existing=True,
            max_instances=1
        )
        logger.info("Scheduled forecasting: Daily at midnight UTC")

    def start(self):
        """Start the scheduler."""
        if not self.scheduler.running:
            self.schedule_jobs()
            self.scheduler.start()
            logger.info("Scheduler started successfully")
        else:
            logger.warning("Scheduler is already running")

    def shutdown(self):
        """Shutdown the scheduler gracefully."""
        if self.scheduler.running:
            self.scheduler.shutdown(wait=True)
            logger.info("Scheduler shut down successfully")
        else:
            logger.warning("Scheduler is not running")

    def get_status(self) -> Dict[str, Any]:
        """
        Get current scheduler status.

        Returns:
            Dict with scheduler status, jobs, and recent history
        """
        jobs = []
        for job in self.scheduler.get_jobs():
            next_run = job.next_run_time
            jobs.append({
                "id": job.id,
                "name": job.name,
                "next_run": next_run.isoformat() if next_run else None,
                "trigger": str(job.trigger),
                "max_instances": job.max_instances
            })

        return {
            "running": self.scheduler.running,
            "timezone": str(timezone.utc),
            "jobs": jobs,
            "job_history": self.job_history
        }

    async def trigger_job_manually(self, job_id: str) -> Dict[str, Any]:
        """
        Manually trigger a scheduled job.

        Args:
            job_id: ID of the job to trigger

        Returns:
            Result of job execution

        Raises:
            ValueError: If job not found
        """
        job = self.scheduler.get_job(job_id)
        if not job:
            raise ValueError(f"Job '{job_id}' not found")

        logger.info(f"Manually triggering job: {job_id}")

        try:
            # Execute the job function directly
            if job_id == "aggregate_refresh":
                await self.refresh_aggregates()
            elif job_id == "forecasting":
                await self.run_forecasting()
            elif job_id.endswith("_collection"):
                provider_name = job_id[: -len("_collection")]
                await self.collect_provider(provider_name)
            else:
                raise ValueError(f"Unknown job: {job_id}")

            return {
                "status": "success",
                "job_id": job_id,
                "message": f"Job {job_id} executed successfully"
            }

        except Exception as e:
            logger.error(f"Manual job execution failed for {job_id}: {str(e)}")
            return {
                "status": "error",
                "job_id": job_id,
                "error": str(e)
            }


# Global scheduler instance
_scheduler_instance: Optional[CollectionScheduler] = None


def get_scheduler() -> CollectionScheduler:
    """
    Get or create the global scheduler instance.

    Returns:
        CollectionScheduler instance
    """
    global _scheduler_instance
    if _scheduler_instance is None:
        _scheduler_instance = CollectionScheduler()
    return _scheduler_instance


def start_scheduler():
    """Start the global scheduler."""
    scheduler = get_scheduler()
    scheduler.start()


def shutdown_scheduler():
    """Shutdown the global scheduler."""
    scheduler = get_scheduler()
    scheduler.shutdown()


def get_scheduler_status() -> Dict[str, Any]:
    """
    Get status of the global scheduler.

    Returns:
        Dict with scheduler status and job information
    """
    scheduler = get_scheduler()
    return scheduler.get_status()
