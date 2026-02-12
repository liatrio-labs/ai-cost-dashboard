"""
Structured logging configuration for the AI Cost Dashboard backend.

Provides JSON-formatted logging with log rotation and different handlers
for development and production environments.
"""

import logging
import sys
from pathlib import Path
from logging.handlers import RotatingFileHandler, TimedRotatingFileHandler
from pythonjsonlogger import jsonlogger
import os


class CustomJsonFormatter(jsonlogger.JsonFormatter):
    """
    Custom JSON formatter that adds service context to all log records.
    """

    def add_fields(self, log_record, record, message_dict):
        super(CustomJsonFormatter, self).add_fields(log_record, record, message_dict)

        # Add service metadata
        log_record['service'] = 'ai-cost-dashboard-backend'
        log_record['environment'] = os.getenv('ENVIRONMENT', 'development')

        # Add log level
        log_record['level'] = record.levelname

        # Add timestamp in ISO format
        log_record['timestamp'] = self.formatTime(record, self.datefmt)

        # Add module and function context
        log_record['module'] = record.module
        log_record['function'] = record.funcName
        log_record['line'] = record.lineno


def setup_logging(
    log_level: str = None,
    log_dir: str = "logs",
    enable_file_logging: bool = True,
    enable_json_logging: bool = None
):
    """
    Configure structured logging for the application.

    Args:
        log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        log_dir: Directory for log files
        enable_file_logging: Whether to write logs to files
        enable_json_logging: Use JSON format. Auto-detects based on environment if None.

    Returns:
        Configured logger instance
    """
    # Determine log level
    if log_level is None:
        log_level = os.getenv('LOG_LEVEL', 'INFO').upper()

    level = getattr(logging, log_level, logging.INFO)

    # Determine if we should use JSON logging (production vs development)
    if enable_json_logging is None:
        environment = os.getenv('ENVIRONMENT', 'development')
        enable_json_logging = environment == 'production'

    # Create log directory if it doesn't exist
    if enable_file_logging:
        log_path = Path(log_dir)
        log_path.mkdir(parents=True, exist_ok=True)

    # Create formatters
    if enable_json_logging:
        # JSON formatter for production
        formatter = CustomJsonFormatter(
            '%(timestamp)s %(level)s %(name)s %(message)s',
            datefmt='%Y-%m-%dT%H:%M:%S%z'
        )
    else:
        # Human-readable formatter for development
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s '
            '[%(filename)s:%(lineno)d]',
            datefmt='%Y-%m-%d %H:%M:%S'
        )

    # Get root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Remove existing handlers
    root_logger.handlers = []

    # Console handler (stdout)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    if enable_file_logging:
        # Main application log with rotation (max 10MB, keep 5 backups)
        app_log_file = Path(log_dir) / "app.log"
        app_handler = RotatingFileHandler(
            app_log_file,
            maxBytes=10 * 1024 * 1024,  # 10MB
            backupCount=5,
            encoding='utf-8'
        )
        app_handler.setLevel(level)
        app_handler.setFormatter(formatter)
        root_logger.addHandler(app_handler)

        # Error log (errors and above only)
        error_log_file = Path(log_dir) / "error.log"
        error_handler = RotatingFileHandler(
            error_log_file,
            maxBytes=10 * 1024 * 1024,  # 10MB
            backupCount=10,
            encoding='utf-8'
        )
        error_handler.setLevel(logging.ERROR)
        error_handler.setFormatter(formatter)
        root_logger.addHandler(error_handler)

        # Daily rotating log for auditing (keeps 30 days)
        audit_log_file = Path(log_dir) / "audit.log"
        audit_handler = TimedRotatingFileHandler(
            audit_log_file,
            when='midnight',
            interval=1,
            backupCount=30,
            encoding='utf-8'
        )
        audit_handler.setLevel(logging.INFO)
        audit_handler.setFormatter(formatter)

        # Create audit logger
        audit_logger = logging.getLogger('audit')
        audit_logger.addHandler(audit_handler)
        audit_logger.setLevel(logging.INFO)
        audit_logger.propagate = False  # Don't propagate to root logger

    # Suppress noisy third-party loggers
    logging.getLogger('httpx').setLevel(logging.WARNING)
    logging.getLogger('httpcore').setLevel(logging.WARNING)
    logging.getLogger('urllib3').setLevel(logging.WARNING)

    logger = logging.getLogger(__name__)
    logger.info(
        f"Logging configured: level={log_level}, json={enable_json_logging}, "
        f"file_logging={enable_file_logging}"
    )

    return root_logger


def get_audit_logger():
    """
    Get the audit logger for recording security-relevant events.

    Returns:
        Audit logger instance
    """
    return logging.getLogger('audit')


def log_request(
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    user_id: str = None,
    error: str = None
):
    """
    Log an HTTP request with structured data.

    Args:
        method: HTTP method (GET, POST, etc.)
        path: Request path
        status_code: HTTP status code
        duration_ms: Request duration in milliseconds
        user_id: Optional user ID
        error: Optional error message
    """
    logger = logging.getLogger('api')

    log_data = {
        'method': method,
        'path': path,
        'status_code': status_code,
        'duration_ms': round(duration_ms, 2),
    }

    if user_id:
        log_data['user_id'] = user_id

    if error:
        log_data['error'] = error

    if status_code >= 500:
        logger.error(f"Request failed: {method} {path}", extra=log_data)
    elif status_code >= 400:
        logger.warning(f"Request error: {method} {path}", extra=log_data)
    else:
        logger.info(f"Request: {method} {path}", extra=log_data)


def log_audit_event(
    event_type: str,
    user_id: str = None,
    resource_type: str = None,
    resource_id: str = None,
    action: str = None,
    metadata: dict = None
):
    """
    Log a security-relevant audit event.

    Args:
        event_type: Type of audit event (e.g., 'auth', 'data_access', 'api_key_creation')
        user_id: User performing the action
        resource_type: Type of resource affected (e.g., 'api_key', 'cost_record')
        resource_id: ID of the resource
        action: Action performed (e.g., 'create', 'read', 'update', 'delete')
        metadata: Additional event-specific data
    """
    audit_logger = get_audit_logger()

    audit_data = {
        'event_type': event_type,
        'user_id': user_id,
        'resource_type': resource_type,
        'resource_id': resource_id,
        'action': action,
    }

    if metadata:
        audit_data.update(metadata)

    audit_logger.info(f"Audit: {event_type}", extra=audit_data)
