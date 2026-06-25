"""
Cache control and security header middleware for FastAPI.

Adds cache-control headers (per-endpoint strategy) and OWASP-aligned
security headers to all responses.
"""

import logging
from typing import Callable
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


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
