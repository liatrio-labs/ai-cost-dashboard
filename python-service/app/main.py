"""
FastAPI backend service for AI Cost Dashboard.
Handles data collection from AI providers and ML-based forecasting.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from contextlib import asynccontextmanager
import logging
import os

from app.routers import health, collection, forecast, scheduler
from app.utils.scheduler import start_scheduler, shutdown_scheduler
from app.utils.logging_config import setup_logging
from app.utils.sentry_config import init_sentry
from app.middleware import RequestLoggingMiddleware, CacheControlMiddleware, SecurityHeadersMiddleware

# Configure structured logging
setup_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown events."""
    logger.info("Starting AI Cost Dashboard backend service...")

    # Initialize Sentry error tracking
    init_sentry()

    # Collection is driven by Vercel Cron (-> POST /api/collection/run-all) by
    # default. The in-process APScheduler is opt-in to avoid double-running the
    # same collectors. Set ENABLE_INTERNAL_SCHEDULER=true to run it (e.g. for a
    # standalone deployment without Vercel Cron).
    internal_scheduler_enabled = os.environ.get(
        "ENABLE_INTERNAL_SCHEDULER", "false"
    ).lower() in ("1", "true", "yes")

    if internal_scheduler_enabled:
        start_scheduler()
        logger.info("Internal scheduler started")
    else:
        logger.info(
            "Internal scheduler disabled (ENABLE_INTERNAL_SCHEDULER not set); "
            "collection is driven by Vercel Cron"
        )

    yield

    if internal_scheduler_enabled:
        shutdown_scheduler()
        logger.info("Internal scheduler shut down")

    logger.info("Shutting down AI Cost Dashboard backend service...")


# Initialize FastAPI app
app = FastAPI(
    title="AI Cost Dashboard API",
    description="Backend service for AI cost tracking and forecasting",
    version="1.0.0",
    lifespan=lifespan
)

# Add security headers middleware (first for all responses)
app.add_middleware(SecurityHeadersMiddleware)

# Add GZip compression for responses > 1000 bytes
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Add cache control headers
app.add_middleware(CacheControlMiddleware)

# Add request logging middleware
app.add_middleware(RequestLoggingMiddleware)

# Configure CORS to allow Vercel frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",  # Local development
        "https://*.vercel.app",   # Vercel preview deployments
        # Add production Vercel domain when deployed
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health.router, tags=["health"])
app.include_router(collection.router)
app.include_router(forecast.router)
app.include_router(scheduler.router)


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "service": "AI Cost Dashboard API",
        "status": "running",
        "version": "1.0.0"
    }
