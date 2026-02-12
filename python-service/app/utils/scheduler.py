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

from app.collectors.anthropic_collector import AnthropicCollector
from app.collectors.openai_collector import OpenAICollector
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

    async def collect_anthropic_data(self):
        """
        Collect data from all active Anthropic API credentials.
        Runs hourly at :05 to avoid top-of-hour traffic.
        """
        logger.info("Starting scheduled Anthropic data collection")

        try:
            supabase = get_supabase_client()

            # Get all active Anthropic credentials
            provider_response = supabase.from_("providers").select("id").eq("name", "anthropic").single().execute()

            if not provider_response.data:
                logger.warning("Anthropic provider not found in database")
                return

            provider_id = provider_response.data["id"]

            # Get all active credentials for Anthropic
            creds_response = (
                supabase.from_("api_credentials")
                .select("user_id, encrypted_api_key")
                .eq("provider_id", provider_id)
                .eq("is_active", True)
                .execute()
            )

            credentials = creds_response.data or []
            logger.info(f"Found {len(credentials)} active Anthropic credentials")

            success_count = 0
            error_count = 0

            # Collect data for each user
            for cred in credentials:
                try:
                    user_id = cred["user_id"]
                    api_key = cred["encrypted_api_key"]  # TODO: Decrypt

                    logger.info(f"Collecting Anthropic data for user {user_id}")

                    async with AnthropicCollector(
                        api_key=api_key,
                        user_id=user_id,
                        provider_id=provider_id
                    ) as collector:
                        result = await collector.run()

                        if result["status"] == "success":
                            success_count += 1
                            logger.info(
                                f"Anthropic collection succeeded for user {user_id}: "
                                f"{result.get('records_stored', 0)} records stored"
                            )
                        else:
                            error_count += 1
                            logger.error(
                                f"Anthropic collection failed for user {user_id}: "
                                f"{result.get('error', 'Unknown error')}"
                            )

                except Exception as e:
                    error_count += 1
                    logger.error(f"Failed to collect Anthropic data for user {cred.get('user_id')}: {str(e)}")

            logger.info(
                f"Anthropic collection completed: {success_count} succeeded, {error_count} failed"
            )

        except Exception as e:
            logger.error(f"Anthropic collection job failed: {str(e)}")
            raise

    async def collect_openai_data(self):
        """
        Collect data from all active OpenAI API credentials.
        Runs every 6 hours (less frequent than Anthropic).
        """
        logger.info("Starting scheduled OpenAI data collection")

        try:
            supabase = get_supabase_client()

            # Get OpenAI provider
            provider_response = supabase.from_("providers").select("id").eq("name", "openai").single().execute()

            if not provider_response.data:
                logger.warning("OpenAI provider not found in database")
                return

            provider_id = provider_response.data["id"]

            # Get all active credentials for OpenAI
            creds_response = (
                supabase.from_("api_credentials")
                .select("user_id, encrypted_api_key")
                .eq("provider_id", provider_id)
                .eq("is_active", True)
                .execute()
            )

            credentials = creds_response.data or []
            logger.info(f"Found {len(credentials)} active OpenAI credentials")

            success_count = 0
            error_count = 0

            # Collect data for each user
            for cred in credentials:
                try:
                    user_id = cred["user_id"]
                    api_key = cred["encrypted_api_key"]  # TODO: Decrypt

                    logger.info(f"Collecting OpenAI data for user {user_id}")

                    async with OpenAICollector(
                        api_key=api_key,
                        user_id=user_id,
                        provider_id=provider_id
                    ) as collector:
                        result = await collector.run()

                        if result["status"] == "success":
                            success_count += 1
                            logger.info(
                                f"OpenAI collection succeeded for user {user_id}: "
                                f"{result.get('records_stored', 0)} records stored"
                            )
                        else:
                            error_count += 1
                            logger.error(
                                f"OpenAI collection failed for user {user_id}: "
                                f"{result.get('error', 'Unknown error')}"
                            )

                except Exception as e:
                    error_count += 1
                    logger.error(f"Failed to collect OpenAI data for user {cred.get('user_id')}: {str(e)}")

            logger.info(
                f"OpenAI collection completed: {success_count} succeeded, {error_count} failed"
            )

        except Exception as e:
            logger.error(f"OpenAI collection job failed: {str(e)}")
            raise

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
        Schedule all data collection and processing jobs.

        Jobs:
        - Anthropic: Every hour at :05
        - OpenAI: Every 6 hours
        - Aggregates: Every 15 minutes
        - Forecasting: Daily at midnight UTC
        """
        # Anthropic collection: Every hour at :05 (avoid top-of-hour traffic)
        self.scheduler.add_job(
            self.collect_anthropic_data,
            trigger=CronTrigger(minute=5, timezone=timezone.utc),
            id="anthropic_collection",
            name="Anthropic Data Collection",
            replace_existing=True,
            max_instances=1  # Prevent overlapping runs
        )
        logger.info("Scheduled Anthropic collection: Every hour at :05")

        # OpenAI collection: Every 6 hours (at 0, 6, 12, 18)
        self.scheduler.add_job(
            self.collect_openai_data,
            trigger=CronTrigger(hour="0,6,12,18", minute=10, timezone=timezone.utc),
            id="openai_collection",
            name="OpenAI Data Collection",
            replace_existing=True,
            max_instances=1
        )
        logger.info("Scheduled OpenAI collection: Every 6 hours at :10")

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
            if job_id == "anthropic_collection":
                await self.collect_anthropic_data()
            elif job_id == "openai_collection":
                await self.collect_openai_data()
            elif job_id == "aggregate_refresh":
                await self.refresh_aggregates()
            elif job_id == "forecasting":
                await self.run_forecasting()
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
