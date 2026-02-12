"""
Middleware for the FastAPI application.
Includes performance, security, and logging middleware.
"""

import time
import logging
from typing import Callable
from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """
    Middleware to log all incoming requests and responses.
    Includes timing information and status codes.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Process the request and log details."""
        start_time = time.time()

        # Log request
        logger.info(
            f"Request started: {request.method} {request.url.path}",
            extra={
                "method": request.method,
                "path": request.url.path,
                "client": request.client.host if request.client else None,
            }
        )

        # Process request
        try:
            response = await call_next(request)
        except Exception as e:
            logger.error(
                f"Request failed: {request.method} {request.url.path} - {str(e)}",
                exc_info=True
            )
            raise

        # Calculate duration
        duration = time.time() - start_time

        # Log response
        logger.info(
            f"Request completed: {request.method} {request.url.path} - "
            f"{response.status_code} in {duration:.3f}s",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration": duration,
            }
        )

        # Add timing header
        response.headers["X-Process-Time"] = str(duration)

        return response


class CacheControlMiddleware(BaseHTTPMiddleware):
    """
    Middleware to add cache control headers to responses.
    Different caching strategies for different endpoints.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Add appropriate cache control headers."""
        response = await call_next(request)

        path = request.url.path

        # Health checks - no cache
        if path.startswith("/health"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"

        # Static data that changes infrequently (5 minutes)
        elif path.startswith("/api/providers") or path.startswith("/api/models"):
            response.headers["Cache-Control"] = "public, max-age=300, s-maxage=300"

        # Cost data (1 minute - balance freshness and performance)
        elif path.startswith("/api/costs"):
            response.headers["Cache-Control"] = "private, max-age=60, stale-while-revalidate=120"

        # Forecasts (5 minutes - expensive to generate)
        elif path.startswith("/api/forecasts"):
            response.headers["Cache-Control"] = "private, max-age=300, stale-while-revalidate=600"

        # Scheduler status (30 seconds)
        elif path.startswith("/api/scheduler"):
            response.headers["Cache-Control"] = "private, max-age=30"

        # API documentation (1 hour)
        elif path in ["/docs", "/redoc", "/openapi.json"]:
            response.headers["Cache-Control"] = "public, max-age=3600"

        # Default - no cache for dynamic content
        else:
            response.headers["Cache-Control"] = "no-cache, must-revalidate"

        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Middleware to add security headers to all responses.
    Implements OWASP best practices.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Add security headers to response."""
        response = await call_next(request)

        # Prevent MIME type sniffing
        response.headers["X-Content-Type-Options"] = "nosniff"

        # Enable XSS protection
        response.headers["X-XSS-Protection"] = "1; mode=block"

        # Prevent clickjacking
        response.headers["X-Frame-Options"] = "DENY"

        # Content Security Policy (strict for API)
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"

        # Referrer policy
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        # Permissions policy (disable unnecessary features)
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"

        # HSTS (HTTP Strict Transport Security) - only in production
        # Commented out for local dev, uncomment for production
        # response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Simple in-memory rate limiting middleware.
    For production, use Redis-based rate limiting.
    """

    def __init__(self, app: ASGIApp, requests_per_minute: int = 60):
        super().__init__(app)
        self.requests_per_minute = requests_per_minute
        self.request_counts: dict = {}
        self.last_reset = time.time()

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Check rate limit and process request."""
        # Reset counts every minute
        current_time = time.time()
        if current_time - self.last_reset > 60:
            self.request_counts = {}
            self.last_reset = current_time

        # Get client identifier
        client_ip = request.client.host if request.client else "unknown"

        # Exempt health checks from rate limiting
        if request.url.path.startswith("/health"):
            return await call_next(request)

        # Check rate limit
        current_count = self.request_counts.get(client_ip, 0)

        if current_count >= self.requests_per_minute:
            logger.warning(f"Rate limit exceeded for {client_ip}")
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Rate limit exceeded",
                    "message": f"Maximum {self.requests_per_minute} requests per minute allowed",
                    "retry_after": 60
                },
                headers={
                    "Retry-After": "60",
                    "X-RateLimit-Limit": str(self.requests_per_minute),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(int(self.last_reset + 60))
                }
            )

        # Increment counter
        self.request_counts[client_ip] = current_count + 1

        # Process request
        response = await call_next(request)

        # Add rate limit headers
        response.headers["X-RateLimit-Limit"] = str(self.requests_per_minute)
        response.headers["X-RateLimit-Remaining"] = str(
            self.requests_per_minute - self.request_counts[client_ip]
        )
        response.headers["X-RateLimit-Reset"] = str(int(self.last_reset + 60))

        return response
