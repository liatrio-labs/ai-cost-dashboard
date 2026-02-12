"""
OpenAI API data collector.
Collects usage and billing data from OpenAI's API endpoints.
"""

import asyncio
from datetime import datetime, timedelta, timezone, date
from typing import Dict, List, Any, Optional
import logging
import httpx
from openai import OpenAI

from app.collectors.base import BaseCollector

logger = logging.getLogger(__name__)


class OpenAICollector(BaseCollector):
    """
    Collector for OpenAI API.

    Uses the following endpoints:
    - GET /v1/usage (usage data by model)
    - GET /v1/dashboard/billing/usage (cost data)
    - GET /v1/dashboard/billing/subscription (billing info)

    Features:
    - Rate limiting from response headers
    - Date range queries (start_date/end_date)
    - Group by: project_id, model, api_key_id
    - Historical limit: 90 days
    - Collection frequency: every 6 hours
    """

    API_BASE_URL = "https://api.openai.com/v1"
    MAX_RETRIES = 3
    INITIAL_BACKOFF = 2  # seconds
    MAX_HISTORICAL_DAYS = 90  # OpenAI's limit

    def __init__(
        self,
        api_key: str,
        user_id: str,
        provider_id: str,
        organization_id: Optional[str] = None
    ):
        """
        Initialize OpenAI collector.

        Args:
            api_key: OpenAI API key
            user_id: User ID who owns this API key
            provider_id: Provider ID from database
            organization_id: Optional OpenAI organization ID
        """
        super().__init__(api_key, user_id)
        self.provider_id = provider_id
        self.organization_id = organization_id
        self.client = OpenAI(api_key=api_key)

        headers = {"Authorization": f"Bearer {api_key}"}
        if organization_id:
            headers["OpenAI-Organization"] = organization_id

        self.http_client = httpx.AsyncClient(
            base_url=self.API_BASE_URL,
            headers=headers,
            timeout=30.0
        )
        self.rate_limit_remaining = None
        self.rate_limit_reset = None

    @property
    def provider_name(self) -> str:
        """Return the provider name."""
        return "openai"

    def _update_rate_limits(self, response: httpx.Response):
        """
        Update rate limit info from response headers.

        Args:
            response: HTTP response with rate limit headers
        """
        # OpenAI rate limit headers
        if "x-ratelimit-remaining-requests" in response.headers:
            self.rate_limit_remaining = int(response.headers["x-ratelimit-remaining-requests"])

        if "x-ratelimit-reset-requests" in response.headers:
            # This is typically a duration like "6s" or "1m"
            reset_str = response.headers["x-ratelimit-reset-requests"]
            self.rate_limit_reset = reset_str

        self.logger.debug(
            f"Rate limits - Remaining: {self.rate_limit_remaining}, "
            f"Reset: {self.rate_limit_reset}"
        )

    async def _make_request_with_retry(
        self,
        method: str,
        endpoint: str,
        params: Optional[Dict[str, Any]] = None,
        retry_count: int = 0
    ) -> Dict[str, Any]:
        """
        Make API request with exponential backoff retry logic.

        Args:
            method: HTTP method (GET, POST)
            endpoint: API endpoint path
            params: Query parameters
            retry_count: Current retry attempt

        Returns:
            Dict: Response JSON

        Raises:
            Exception: If all retries fail
        """
        try:
            if method == "GET":
                response = await self.http_client.get(endpoint, params=params)
            else:
                response = await self.http_client.post(endpoint, params=params)

            # Update rate limit tracking
            self._update_rate_limits(response)

            response.raise_for_status()
            return response.json()

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429 and retry_count < self.MAX_RETRIES:
                # Rate limit exceeded - wait and retry
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)

                # Check if we have reset time from headers
                if self.rate_limit_reset:
                    self.logger.warning(
                        f"Rate limit hit, reset in {self.rate_limit_reset}. "
                        f"Backing off for {backoff_time}s"
                    )
                else:
                    self.logger.warning(
                        f"Rate limit hit, backing off for {backoff_time}s "
                        f"(attempt {retry_count + 1}/{self.MAX_RETRIES})"
                    )

                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(method, endpoint, params, retry_count + 1)

            elif e.response.status_code >= 500 and retry_count < self.MAX_RETRIES:
                # Server error - retry with backoff
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(
                    f"Server error {e.response.status_code}, retrying in {backoff_time}s"
                )
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(method, endpoint, params, retry_count + 1)

            else:
                self.logger.error(
                    f"API request failed: {e.response.status_code} - {e.response.text}"
                )
                raise

        except Exception as e:
            if retry_count < self.MAX_RETRIES:
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(f"Request failed: {str(e)}, retrying in {backoff_time}s")
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(method, endpoint, params, retry_count + 1)
            raise

    async def fetch_usage_data(
        self,
        start_date: date,
        end_date: date
    ) -> List[Dict[str, Any]]:
        """
        Fetch usage data from OpenAI API.

        Args:
            start_date: Start date for usage query
            end_date: End date for usage query

        Returns:
            List of usage records

        API Response format:
        {
            "object": "list",
            "data": [
                {
                    "aggregation_timestamp": 1707609600,
                    "n_requests": 5,
                    "operation": "completions",
                    "snapshot_id": "...",
                    "n_context_tokens_total": 1000,
                    "n_generated_tokens_total": 500
                }
            ],
            "ft_data": [],
            "dalle_api_data": []
        }
        """
        self.logger.info(f"Fetching usage data from {start_date} to {end_date}")

        params = {
            "date": start_date.isoformat()  # OpenAI uses single date param for daily queries
        }

        all_records = []
        current_date = start_date

        while current_date <= end_date:
            params["date"] = current_date.isoformat()

            try:
                response = await self._make_request_with_retry("GET", "/usage", params=params)

                # Collect data from all sections
                data = response.get("data", [])
                ft_data = response.get("ft_data", [])
                dalle_data = response.get("dalle_api_data", [])

                all_records.extend(data)
                all_records.extend(ft_data)
                all_records.extend(dalle_data)

                self.logger.info(
                    f"Retrieved {len(data)} records for {current_date} "
                    f"(total: {len(all_records)})"
                )

            except Exception as e:
                self.logger.warning(f"Failed to fetch data for {current_date}: {str(e)}")

            # Move to next day
            current_date += timedelta(days=1)

            # Small delay to respect rate limits
            if current_date <= end_date:
                await asyncio.sleep(0.5)

        return all_records

    async def fetch_billing_usage(
        self,
        start_date: date,
        end_date: date
    ) -> Dict[str, Any]:
        """
        Fetch billing usage data from OpenAI dashboard API.

        Args:
            start_date: Start date for billing query
            end_date: End date for billing query

        Returns:
            Billing usage data with daily breakdown

        API Response format:
        {
            "object": "list",
            "daily_costs": [
                {
                    "timestamp": 1707609600,
                    "line_items": [
                        {
                            "name": "GPT-4 Turbo",
                            "cost": 1.50
                        }
                    ]
                }
            ],
            "total_usage": 45.67
        }
        """
        self.logger.info(f"Fetching billing usage from {start_date} to {end_date}")

        params = {
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat()
        }

        response = await self._make_request_with_retry(
            "GET",
            "/dashboard/billing/usage",
            params=params
        )

        return response

    async def fetch_subscription_info(self) -> Dict[str, Any]:
        """
        Fetch subscription information from OpenAI.

        Returns:
            Subscription details including billing limits

        API Response format:
        {
            "object": "billing_subscription",
            "has_payment_method": true,
            "canceled": false,
            "canceled_at": null,
            "delinquent": false,
            "access_until": 1712620800,
            "soft_limit": 100,
            "hard_limit": 120,
            "system_hard_limit": 150,
            "soft_limit_usd": 100.00,
            "hard_limit_usd": 120.00
        }
        """
        self.logger.info("Fetching subscription information")

        response = await self._make_request_with_retry(
            "GET",
            "/dashboard/billing/subscription"
        )

        return response

    def transform_to_cost_records(
        self,
        usage_data: List[Dict[str, Any]],
        billing_data: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """
        Transform OpenAI API data to cost_records schema.

        Combines usage and billing data, matching by timestamp and model.

        Args:
            usage_data: Usage data (tokens, requests)
            billing_data: Billing data (costs in USD)

        Returns:
            List of records matching cost_records schema
        """
        transformed_records = []

        # Create a map of costs by timestamp and model
        cost_map = {}
        for daily_cost in billing_data.get("daily_costs", []):
            timestamp = daily_cost.get("timestamp")
            for line_item in daily_cost.get("line_items", []):
                model_name = line_item.get("name", "unknown")
                cost = line_item.get("cost", 0.0)
                key = (timestamp, model_name)
                cost_map[key] = cost

        # Process usage data
        for usage_record in usage_data:
            timestamp_unix = usage_record.get("aggregation_timestamp")
            if not timestamp_unix:
                continue

            # Convert Unix timestamp to datetime
            try:
                timestamp = datetime.fromtimestamp(timestamp_unix, tz=timezone.utc)
            except Exception as e:
                self.logger.warning(f"Failed to parse timestamp {timestamp_unix}: {e}")
                continue

            # Determine model name from operation
            operation = usage_record.get("operation", "unknown")
            model_name = self._map_operation_to_model(operation, usage_record)

            # Get cost for this record
            cost_usd = cost_map.get((timestamp_unix, model_name), 0.0)

            # Calculate tokens
            context_tokens = usage_record.get("n_context_tokens_total", 0)
            generated_tokens = usage_record.get("n_generated_tokens_total", 0)
            total_tokens = context_tokens + generated_tokens

            # Build record matching cost_records schema
            record = {
                "user_id": self.user_id,
                "provider_id": self.provider_id,
                "timestamp": timestamp.isoformat(),
                "model_name": model_name,
                "cost_usd": float(cost_usd),
                "tokens_used": total_tokens,
                "input_tokens": context_tokens,
                "output_tokens": generated_tokens,
                "request_count": usage_record.get("n_requests", 1),
                "collection_method": "api_automated",
                "metadata": {
                    "provider": "openai",
                    "operation": operation,
                    "snapshot_id": usage_record.get("snapshot_id"),
                    "organization_id": self.organization_id
                }
            }

            transformed_records.append(record)

        self.logger.info(f"Transformed {len(transformed_records)} records")
        return transformed_records

    def _map_operation_to_model(
        self,
        operation: str,
        usage_record: Dict[str, Any]
    ) -> str:
        """
        Map OpenAI operation to model name.

        Args:
            operation: Operation type (e.g., "completions", "embeddings")
            usage_record: Full usage record for context

        Returns:
            Model name string
        """
        # Try to get model from metadata if available
        if "model" in usage_record:
            return usage_record["model"]

        # Map common operations to model families
        operation_map = {
            "completions": "gpt-4",
            "chat.completions": "gpt-4",
            "embeddings": "text-embedding-ada-002",
            "images": "dall-e-3",
            "audio.transcriptions": "whisper-1",
            "audio.speech": "tts-1"
        }

        return operation_map.get(operation, f"openai-{operation}")

    async def collect_data(
        self,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
        backfill: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Collect cost data from OpenAI API.

        Args:
            start_date: Start date of collection period (defaults to 1 day ago)
            end_date: End date of collection period (defaults to today)
            backfill: If True, fetch maximum historical data (90 days)

        Returns:
            List of cost records ready for database insertion
        """
        # Set default date range
        if end_date is None:
            end_date = date.today()

        if start_date is None:
            if backfill:
                # For backfill, go back 90 days (OpenAI's limit)
                start_date = end_date - timedelta(days=self.MAX_HISTORICAL_DAYS)
                self.logger.info(f"Backfill mode: collecting last {self.MAX_HISTORICAL_DAYS} days")
            else:
                # Regular collection: last 1 day
                start_date = end_date - timedelta(days=1)

        # Validate date range
        max_start = end_date - timedelta(days=self.MAX_HISTORICAL_DAYS)
        if start_date < max_start:
            self.logger.warning(
                f"Start date {start_date} exceeds OpenAI's {self.MAX_HISTORICAL_DAYS}-day limit. "
                f"Adjusting to {max_start}"
            )
            start_date = max_start

        try:
            # Fetch usage and billing data in parallel
            usage_task = self.fetch_usage_data(start_date, end_date)
            billing_task = self.fetch_billing_usage(start_date, end_date)

            usage_data, billing_data = await asyncio.gather(usage_task, billing_task)

            # Transform to standard schema
            records = self.transform_to_cost_records(usage_data, billing_data)

            self.logger.info(
                f"Successfully collected {len(records)} records from OpenAI API "
                f"({start_date} to {end_date})"
            )

            return records

        except Exception as e:
            self.logger.error(f"Failed to collect OpenAI data: {str(e)}")
            raise

    async def backfill_historical_data(self, days: int = 90) -> Dict[str, Any]:
        """
        Backfill historical data from OpenAI API.

        Args:
            days: Number of days to backfill (max 90 for OpenAI)

        Returns:
            Summary of backfill operation
        """
        # Enforce OpenAI's 90-day limit
        if days > self.MAX_HISTORICAL_DAYS:
            self.logger.warning(
                f"Requested {days} days, but OpenAI only allows {self.MAX_HISTORICAL_DAYS} days. "
                f"Using {self.MAX_HISTORICAL_DAYS}"
            )
            days = self.MAX_HISTORICAL_DAYS

        end_date = date.today()
        start_date = end_date - timedelta(days=days)

        self.logger.info(f"Starting backfill for {days} days of OpenAI data")

        try:
            records = await self.collect_data(start_date, end_date, backfill=True)
            stored_count = await self.store_records(records)

            return {
                "status": "success",
                "provider": self.provider_name,
                "backfill_days": days,
                "records_collected": len(records),
                "records_stored": stored_count,
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat()
            }

        except Exception as e:
            self.logger.error(f"Backfill failed: {str(e)}")
            return {
                "status": "error",
                "provider": self.provider_name,
                "error": str(e)
            }

    async def get_subscription_limits(self) -> Dict[str, Any]:
        """
        Get current subscription limits and usage.

        Returns:
            Subscription information with soft/hard limits
        """
        try:
            subscription = await self.fetch_subscription_info()
            return {
                "status": "success",
                "has_payment_method": subscription.get("has_payment_method"),
                "soft_limit_usd": subscription.get("soft_limit_usd"),
                "hard_limit_usd": subscription.get("hard_limit_usd"),
                "access_until": subscription.get("access_until")
            }
        except Exception as e:
            self.logger.error(f"Failed to fetch subscription info: {str(e)}")
            return {
                "status": "error",
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
