"""
FastAPI backend service for AI Cost Dashboard.
Handles data collection from AI providers and ML-based forecasting.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from contextlib import asynccontextmanager
import logging

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

    # Start the scheduler
    start_scheduler()
    logger.info("Scheduler started")

    yield

    # Shutdown the scheduler
    shutdown_scheduler()
    logger.info("Scheduler shut down")

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
