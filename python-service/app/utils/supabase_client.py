"""Supabase client utility for database operations."""

import os
from supabase import create_client, Client
from functools import lru_cache
import logging

logger = logging.getLogger(__name__)


@lru_cache()
def get_supabase_client() -> Client:
    """
    Get or create a Supabase client instance.
    Uses lru_cache to ensure we reuse the same client instance.

    Returns:
        Client: Supabase client instance

    Raises:
        ValueError: If required environment variables are missing
    """
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY")

    if not supabase_url or not supabase_key:
        raise ValueError(
            "Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_KEY"
        )

    logger.info(f"Initializing Supabase client for URL: {supabase_url}")

    return create_client(supabase_url, supabase_key)


def test_connection() -> bool:
    """
    Test the Supabase connection.

    Returns:
        bool: True if connection is successful, False otherwise
    """
    try:
        client = get_supabase_client()
        # Simple query to test connection
        response = client.from_("users").select("count", count="exact").limit(1).execute()
        logger.info("Supabase connection test successful")
        return True
    except Exception as e:
        logger.error(f"Supabase connection test failed: {str(e)}")
        return False
