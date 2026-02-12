"""
Request/Response logging middleware for FastAPI.

Logs all incoming requests and outgoing responses with timing information.
"""

import logging
import time
from typing import Callable
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.utils.logging_config import log_request

logger = logging.getLogger(__name__)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """
    Middleware to log all HTTP requests and responses.

    Captures:
    - Request method and path
    - Response status code
    - Request duration
    - User ID (if available from auth)
    - Errors (if any)
    """

    def __init__(self, app: ASGIApp):
        super().__init__(app)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """
        Process request and log details.

        Args:
            request: Incoming HTTP request
            call_next: Next middleware/route handler

        Returns:
            HTTP response
        """
        # Start timer
        start_time = time.time()

        # Extract request details
        method = request.method
        path = request.url.path
        user_id = None

        # Try to extract user_id from request state (set by auth middleware)
        if hasattr(request.state, 'user_id'):
            user_id = request.state.user_id

        # Process request
        error = None
        try:
            response = await call_next(request)
            status_code = response.status_code
        except Exception as e:
            # Log the exception
            logger.error(f"Request failed with exception: {str(e)}", exc_info=True)
            error = str(e)
            status_code = 500
            # Re-raise to let FastAPI handle it
            raise
        finally:
            # Calculate duration
            duration_ms = (time.time() - start_time) * 1000

            # Log the request
            log_request(
                method=method,
                path=path,
                status_code=status_code,
                duration_ms=duration_ms,
                user_id=user_id,
                error=error
            )

        return response
