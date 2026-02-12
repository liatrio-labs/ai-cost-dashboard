"""
Vercel-compatible FastAPI app entry point
Serverless-optimized version without background scheduler
"""
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from contextlib import asynccontextmanager
import logging

from app.routers import health, collection, forecast
from app.utils.logging_config import setup_logging
from app.utils.sentry_config import init_sentry
from app.middleware import RequestLoggingMiddleware, CacheControlMiddleware, SecurityHeadersMiddleware

# Configure structured logging
setup_logging()
logger = logging.getLogger(__name__)

# Set environment flag for serverless
os.environ['SERVERLESS'] = 'true'


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown events (serverless)."""
    logger.info("Starting AI Cost Dashboard backend service (Vercel serverless)...")

    # Initialize Sentry error tracking
    init_sentry()

    # Note: Scheduler not started in serverless mode
    # Vercel Cron Jobs will call the collection endpoints directly
    logger.info("Serverless mode: using Vercel Cron instead of APScheduler")

    yield

    logger.info("Shutting down AI Cost Dashboard backend service...")


# Initialize FastAPI app (serverless-optimized)
app = FastAPI(
    title="AI Cost Dashboard API",
    description="Backend service for AI cost tracking and forecasting (Vercel Serverless)",
    version="1.0.0",
    lifespan=lifespan
)

# Add CORS middleware (allow Vercel frontend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://*.vercel.app",
        "https://ai-cost-dashboard.vercel.app"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add middleware stack
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(CacheControlMiddleware)
app.add_middleware(RequestLoggingMiddleware)

# Register routers
app.include_router(health.router, prefix="/health", tags=["health"])
app.include_router(collection.router, prefix="/api/collection", tags=["collection"])
app.include_router(forecast.router, prefix="/api/forecast", tags=["forecast"])

# Note: Scheduler router not included in serverless mode
# Vercel Cron Jobs will call collection endpoints directly

@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": "AI Cost Dashboard API",
        "version": "1.0.0",
        "mode": "serverless",
        "docs": "/docs",
        "health": "/health"
    }


# Export for Vercel
handler = app
