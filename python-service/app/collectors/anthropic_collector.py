"""
Anthropic Admin API data collector.
Collects cost and usage data from Anthropic's Admin API endpoints.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Any, Optional
import logging
import httpx
from anthropic import Anthropic

from app.collectors.base import BaseCollector

logger = logging.getLogger(__name__)


class AnthropicCollector(BaseCollector):
    """
    Collector for Anthropic Admin API.

    Uses the following endpoints:
    - POST /v1/organizations/usage_report/messages
    - POST /v1/organizations/cost_report

    Features:
    - Rate limiting (max 1 req/min sustained)
    - Pagination support with next_page tokens
    - Backfill for historical data
    - Data freshness: ~5 minutes
    """

    ADMIN_API_BASE_URL = "https://api.anthropic.com/v1/organizations"
    RATE_LIMIT_DELAY = 60  # seconds between requests
    MAX_RETRIES = 3
    INITIAL_BACKOFF = 2  # seconds

    def __init__(
        self,
        api_key: str,
        user_id: str,
        provider_id: str,
        organization_id: Optional[str] = None
    ):
        """
        Initialize Anthropic collector.

        Args:
            api_key: Anthropic Admin API key
            user_id: User ID who owns this API key
            provider_id: Provider ID from database
            organization_id: Optional organization ID (extracted from API key if not provided)
        """
        super().__init__(api_key, user_id)
        self.provider_id = provider_id
        self.organization_id = organization_id
        self.client = Anthropic(api_key=api_key)
        self.http_client = httpx.AsyncClient(
            base_url=self.ADMIN_API_BASE_URL,
            headers={
                "anthropic-version": "2023-06-01",
                "x-api-key": api_key
            },
            timeout=30.0
        )

    @property
    def provider_name(self) -> str:
        """Return the provider name."""
        return "anthropic"

    async def _make_request_with_retry(
        self,
        method: str,
        endpoint: str,
        json_data: Optional[Dict[str, Any]] = None,
        retry_count: int = 0
    ) -> Dict[str, Any]:
        """
        Make API request with exponential backoff retry logic.

        Args:
            method: HTTP method (GET, POST)
            endpoint: API endpoint path
            json_data: Request body JSON
            retry_count: Current retry attempt

        Returns:
            Dict: Response JSON

        Raises:
            Exception: If all retries fail
        """
        try:
            if method == "POST":
                response = await self.http_client.post(endpoint, json=json_data)
            else:
                response = await self.http_client.get(endpoint)

            response.raise_for_status()
            return response.json()

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429 and retry_count < self.MAX_RETRIES:
                # Rate limit exceeded - wait and retry
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(
                    f"Rate limit hit, backing off for {backoff_time}s (attempt {retry_count + 1}/{self.MAX_RETRIES})"
                )
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(method, endpoint, json_data, retry_count + 1)

            elif e.response.status_code >= 500 and retry_count < self.MAX_RETRIES:
                # Server error - retry with backoff
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(
                    f"Server error {e.response.status_code}, retrying in {backoff_time}s"
                )
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(method, endpoint, json_data, retry_count + 1)

            else:
                self.logger.error(f"API request failed: {e.response.status_code} - {e.response.text}")
                raise

        except Exception as e:
            if retry_count < self.MAX_RETRIES:
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(f"Request failed: {str(e)}, retrying in {backoff_time}s")
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(method, endpoint, json_data, retry_count + 1)
            raise

    async def fetch_usage_report(
        self,
        start_time: datetime,
        end_time: datetime,
        granularity: str = "1h"
    ) -> List[Dict[str, Any]]:
        """
        Fetch usage report from Anthropic Admin API.

        Args:
            start_time: Start of time range (UTC)
            end_time: End of time range (UTC)
            granularity: Time granularity (1m, 1h, 1d)

        Returns:
            List of usage records with pagination handling

        API Response format:
        {
            "data": [
                {
                    "start_time": "2026-02-11T00:00:00Z",
                    "end_time": "2026-02-11T01:00:00Z",
                    "model": "claude-3-opus-20240229",
                    "input_tokens": 1000,
                    "output_tokens": 500,
                    "request_count": 5
                }
            ],
            "next_page": "optional-pagination-token"
        }
        """
        all_records = []
        next_page = None

        # Ensure times are in ISO format
        start_time_str = start_time.isoformat()
        end_time_str = end_time.isoformat()

        self.logger.info(
            f"Fetching usage report from {start_time_str} to {end_time_str} "
            f"with granularity {granularity}"
        )

        while True:
            # Prepare request body
            request_data = {
                "start_time": start_time_str,
                "end_time": end_time_str,
                "granularity": granularity
            }

            if next_page:
                request_data["next_page"] = next_page

            # Make API request with rate limiting
            response = await self._make_request_with_retry(
                "POST",
                "/usage_report/messages",
                json_data=request_data
            )

            # Add records from this page
            page_data = response.get("data", [])
            all_records.extend(page_data)

            self.logger.info(f"Retrieved {len(page_data)} records (total: {len(all_records)})")

            # Check for next page
            next_page = response.get("next_page")
            if not next_page:
                break

            # Rate limiting - wait before next request
            await asyncio.sleep(self.RATE_LIMIT_DELAY)

        return all_records

    async def fetch_cost_report(
        self,
        start_time: datetime,
        end_time: datetime,
        granularity: str = "1h"
    ) -> List[Dict[str, Any]]:
        """
        Fetch cost report from Anthropic Admin API.

        Args:
            start_time: Start of time range (UTC)
            end_time: End of time range (UTC)
            granularity: Time granularity (1m, 1h, 1d)

        Returns:
            List of cost records with pagination handling

        API Response format:
        {
            "data": [
                {
                    "start_time": "2026-02-11T00:00:00Z",
                    "end_time": "2026-02-11T01:00:00Z",
                    "model": "claude-3-opus-20240229",
                    "cost_usd": 0.15
                }
            ],
            "next_page": "optional-pagination-token"
        }
        """
        all_records = []
        next_page = None

        start_time_str = start_time.isoformat()
        end_time_str = end_time.isoformat()

        self.logger.info(
            f"Fetching cost report from {start_time_str} to {end_time_str} "
            f"with granularity {granularity}"
        )

        while True:
            request_data = {
                "start_time": start_time_str,
                "end_time": end_time_str,
                "granularity": granularity
            }

            if next_page:
                request_data["next_page"] = next_page

            response = await self._make_request_with_retry(
                "POST",
                "/cost_report",
                json_data=request_data
            )

            page_data = response.get("data", [])
            all_records.extend(page_data)

            self.logger.info(f"Retrieved {len(page_data)} cost records (total: {len(all_records)})")

            next_page = response.get("next_page")
            if not next_page:
                break

            await asyncio.sleep(self.RATE_LIMIT_DELAY)

        return all_records

    def transform_to_cost_records(
        self,
        usage_data: List[Dict[str, Any]],
        cost_data: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Transform Anthropic API data to cost_records schema.

        Combines usage and cost data, matching by time period and model.

        Args:
            usage_data: Usage report data (tokens, request counts)
            cost_data: Cost report data (USD costs)

        Returns:
            List of records matching cost_records schema
        """
        # Create a lookup map for cost data
        cost_map = {}
        for cost_record in cost_data:
            key = (
                cost_record.get("start_time"),
                cost_record.get("model")
            )
            cost_map[key] = cost_record.get("cost_usd", 0.0)

        # Transform records
        transformed_records = []

        for usage_record in usage_data:
            start_time = usage_record.get("start_time")
            model = usage_record.get("model")
            key = (start_time, model)

            # Get matching cost, default to 0 if not found
            cost_usd = cost_map.get(key, 0.0)

            # Parse timestamp
            try:
                timestamp = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
            except Exception as e:
                self.logger.warning(f"Failed to parse timestamp {start_time}: {e}")
                continue

            # Build record matching cost_records schema
            record = {
                "user_id": self.user_id,
                "provider_id": self.provider_id,
                "timestamp": timestamp.isoformat(),
                "model_name": model,
                "cost_usd": float(cost_usd),
                "tokens_used": usage_record.get("input_tokens", 0) + usage_record.get("output_tokens", 0),
                "input_tokens": usage_record.get("input_tokens", 0),
                "output_tokens": usage_record.get("output_tokens", 0),
                "request_count": usage_record.get("request_count", 1),
                "collection_method": "api_automated",
                "metadata": {
                    "provider": "anthropic",
                    "granularity": "1h",
                    "end_time": usage_record.get("end_time"),
                    "organization_id": self.organization_id
                }
            }

            transformed_records.append(record)

        self.logger.info(f"Transformed {len(transformed_records)} records")
        return transformed_records

    async def collect_data(
        self,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        backfill: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Collect cost data from Anthropic Admin API.

        Args:
            start_time: Start of collection period (defaults to 24 hours ago)
            end_time: End of collection period (defaults to now)
            backfill: If True, fetch full historical data

        Returns:
            List of cost records ready for database insertion
        """
        # Set default time range
        if end_time is None:
            end_time = datetime.now(timezone.utc)

        if start_time is None:
            if backfill:
                # For backfill, go back 90 days (or as needed)
                start_time = end_time - timedelta(days=90)
                self.logger.info("Backfill mode: collecting last 90 days of data")
            else:
                # Regular collection: last 24 hours
                start_time = end_time - timedelta(hours=24)

        try:
            # Fetch usage and cost data in parallel
            usage_task = self.fetch_usage_report(start_time, end_time, granularity="1h")
            cost_task = self.fetch_cost_report(start_time, end_time, granularity="1h")

            usage_data, cost_data = await asyncio.gather(usage_task, cost_task)

            # Transform to standard schema
            records = self.transform_to_cost_records(usage_data, cost_data)

            self.logger.info(
                f"Successfully collected {len(records)} records from Anthropic API "
                f"({start_time.isoformat()} to {end_time.isoformat()})"
            )

            return records

        except Exception as e:
            self.logger.error(f"Failed to collect Anthropic data: {str(e)}")
            raise

    async def backfill_historical_data(self, days: int = 90) -> Dict[str, Any]:
        """
        Backfill historical data from Anthropic API.

        Args:
            days: Number of days to backfill

        Returns:
            Summary of backfill operation
        """
        end_time = datetime.now(timezone.utc)
        start_time = end_time - timedelta(days=days)

        self.logger.info(f"Starting backfill for {days} days of Anthropic data")

        try:
            records = await self.collect_data(start_time, end_time, backfill=True)
            stored_count = await self.store_records(records)

            return {
                "status": "success",
                "provider": self.provider_name,
                "backfill_days": days,
                "records_collected": len(records),
                "records_stored": stored_count,
                "start_time": start_time.isoformat(),
                "end_time": end_time.isoformat()
            }

        except Exception as e:
            self.logger.error(f"Backfill failed: {str(e)}")
            return {
                "status": "error",
                "provider": self.provider_name,
                "error": str(e)
            }

    async def close(self):
        """Close HTTP client connection."""
        await self.http_client.aclose()

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()
