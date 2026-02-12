"""
Sentry error tracking configuration.

Integrates Sentry for error monitoring and alerting in production.
"""

import logging
import os
import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.logging import LoggingIntegration

logger = logging.getLogger(__name__)


def init_sentry():
    """
    Initialize Sentry error tracking.

    Reads configuration from environment variables:
    - SENTRY_DSN: Sentry project DSN (required for Sentry to be enabled)
    - SENTRY_ENVIRONMENT: Environment name (default: 'development')
    - SENTRY_TRACES_SAMPLE_RATE: Percentage of transactions to trace (default: 0.1)
    - SENTRY_PROFILES_SAMPLE_RATE: Percentage of transactions to profile (default: 0.1)
    """
    sentry_dsn = os.getenv('SENTRY_DSN')

    if not sentry_dsn:
        logger.info("Sentry DSN not configured. Error tracking disabled.")
        return

    environment = os.getenv('SENTRY_ENVIRONMENT', os.getenv('ENVIRONMENT', 'development'))
    traces_sample_rate = float(os.getenv('SENTRY_TRACES_SAMPLE_RATE', '0.1'))
    profiles_sample_rate = float(os.getenv('SENTRY_PROFILES_SAMPLE_RATE', '0.1'))

    # Configure logging integration
    # Send ERROR and above to Sentry as events
    logging_integration = LoggingIntegration(
        level=logging.INFO,        # Capture INFO and above as breadcrumbs
        event_level=logging.ERROR  # Send ERROR and above as events
    )

    # Initialize Sentry
    sentry_sdk.init(
        dsn=sentry_dsn,
        environment=environment,
        traces_sample_rate=traces_sample_rate,
        profiles_sample_rate=profiles_sample_rate,
        integrations=[
            FastApiIntegration(
                transaction_style="url"  # Group by URL pattern
            ),
            logging_integration,
        ],
        # Send default PII (Personally Identifiable Information)
        send_default_pii=False,
        # Attach stack traces to messages
        attach_stacktrace=True,
        # Release version (can be set via environment variable)
        release=os.getenv('RELEASE_VERSION', 'unknown'),
        # Before send hook to filter/modify events
        before_send=filter_sentry_event,
    )

    logger.info(
        f"Sentry initialized: environment={environment}, "
        f"traces_sample_rate={traces_sample_rate}"
    )


def filter_sentry_event(event, hint):
    """
    Filter or modify events before sending to Sentry.

    Args:
        event: Sentry event dictionary
        hint: Additional context about the event

    Returns:
        Modified event or None to drop the event
    """
    # Don't send events for certain exceptions
    if 'exc_info' in hint:
        exc_type, exc_value, tb = hint['exc_info']

        # Filter out expected errors
        ignored_exceptions = [
            'HTTPException',  # These are expected API errors
            'RequestValidationError',  # Pydantic validation errors
        ]

        if exc_type.__name__ in ignored_exceptions:
            # Still log locally but don't send to Sentry
            return None

    # Filter sensitive data from event
    if 'request' in event:
        request = event['request']

        # Remove sensitive headers
        if 'headers' in request:
            sensitive_headers = ['authorization', 'cookie', 'x-api-key']
            for header in sensitive_headers:
                if header in request['headers']:
                    request['headers'][header] = '[Filtered]'

        # Remove sensitive query parameters
        if 'query_string' in request:
            sensitive_params = ['api_key', 'token', 'password']
            # Note: You may need more sophisticated query string parsing
            for param in sensitive_params:
                if param in request.get('query_string', ''):
                    request['query_string'] = '[Filtered]'

    return event


def capture_exception(exception: Exception, context: dict = None):
    """
    Manually capture an exception to Sentry with additional context.

    Args:
        exception: Exception to capture
        context: Additional context to attach to the event
    """
    with sentry_sdk.push_scope() as scope:
        if context:
            for key, value in context.items():
                scope.set_context(key, value)

        sentry_sdk.capture_exception(exception)


def capture_message(message: str, level: str = 'info', context: dict = None):
    """
    Manually send a message to Sentry.

    Args:
        message: Message to send
        level: Message level ('debug', 'info', 'warning', 'error', 'fatal')
        context: Additional context to attach
    """
    with sentry_sdk.push_scope() as scope:
        if context:
            for key, value in context.items():
                scope.set_context(key, value)

        sentry_sdk.capture_message(message, level=level)
