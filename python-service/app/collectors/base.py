"""Base collector class for API data collection."""

from abc import ABC, abstractmethod
from typing import Dict, List, Any, Optional
from datetime import datetime
import logging

from app.utils.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


class BaseCollector(ABC):
    """
    Abstract base class for API data collectors.

    Provides common functionality for collecting cost data from AI providers
    and storing it in the database.
    """

    def __init__(self, api_key: str, user_id: str):
        """
        Initialize the collector.

        Args:
            api_key: API key for the provider (encrypted)
            user_id: User ID who owns this API key
        """
        self.api_key = api_key
        self.user_id = user_id
        self.supabase = get_supabase_client()
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Return the provider name (e.g., 'anthropic', 'openai')."""
        pass

    @abstractmethod
    async def collect_data(self) -> List[Dict[str, Any]]:
        """
        Collect cost data from the provider's API.

        Returns:
            List[Dict]: List of cost records to be stored

        Raises:
            Exception: If data collection fails
        """
        pass

    async def store_records(self, records: List[Dict[str, Any]]) -> int:
        """
        Store collected records in the database.

        Args:
            records: List of cost records to store

        Returns:
            int: Number of records successfully stored

        Raises:
            Exception: If database operation fails
        """
        if not records:
            self.logger.info(f"No records to store for {self.provider_name}")
            return 0

        try:
            # Add user_id to each record
            for record in records:
                record["user_id"] = self.user_id
                record["provider"] = self.provider_name
                if "collected_at" not in record:
                    record["collected_at"] = datetime.utcnow().isoformat()

            # Insert records into costs table
            response = self.supabase.from_("costs").insert(records).execute()

            stored_count = len(response.data) if response.data else 0
            self.logger.info(
                f"Successfully stored {stored_count} records for {self.provider_name}"
            )
            return stored_count

        except Exception as e:
            self.logger.error(
                f"Failed to store records for {self.provider_name}: {str(e)}"
            )
            raise

    async def run(self) -> Dict[str, Any]:
        """
        Execute the full collection workflow: collect data and store it.

        Returns:
            Dict: Summary of the collection run with status and stats

        Example:
            {
                "status": "success",
                "provider": "anthropic",
                "records_collected": 10,
                "records_stored": 10,
                "timestamp": "2026-02-11T12:00:00Z"
            }
        """
        start_time = datetime.utcnow()
        self.logger.info(f"Starting data collection for {self.provider_name}")

        try:
            # Collect data from API
            records = await self.collect_data()
            records_collected = len(records)

            # Store in database
            records_stored = await self.store_records(records)

            result = {
                "status": "success",
                "provider": self.provider_name,
                "records_collected": records_collected,
                "records_stored": records_stored,
                "timestamp": start_time.isoformat()
            }

            self.logger.info(
                f"Collection completed for {self.provider_name}: "
                f"{records_stored}/{records_collected} records stored"
            )
            return result

        except Exception as e:
            self.logger.error(
                f"Collection failed for {self.provider_name}: {str(e)}"
            )
            return {
                "status": "error",
                "provider": self.provider_name,
                "error": str(e),
                "timestamp": start_time.isoformat()
            }

    def decrypt_api_key(self, encrypted_key: str) -> str:
        """
        Decrypt the API key for use with the provider.

        Args:
            encrypted_key: Encrypted API key from database

        Returns:
            str: Decrypted API key

        Note:
            This is a placeholder. Actual implementation will use
            the encryption utility from app.utils.encryption
        """
        # TODO: Implement with actual encryption utility
        # For now, assume keys are stored in plain text (development only)
        return encrypted_key
