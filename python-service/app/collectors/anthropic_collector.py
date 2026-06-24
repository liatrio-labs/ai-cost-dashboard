"""
Anthropic Admin API data collector (platform.claude.com / developer API).

Collects cost and usage data from Anthropic's organization-level Admin API:
- GET /v1/organizations/cost_report
- GET /v1/organizations/usage_report/messages

Requires an Admin API key (sk-ant-admin...). This is distinct from the Claude
Enterprise Analytics API (claude.ai surface), which is handled by
ClaudeAIAnalyticsCollector.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Any, Optional, Tuple
import logging
import httpx

from app.collectors.base import BaseCollector

logger = logging.getLogger(__name__)


class AnthropicCollector(BaseCollector):
    """
    Collector for the Anthropic Admin API.

    Endpoints (GET, query-parameterized):
    - /cost_report   -> USD cost, bucketed by time
    - /usage_report/messages -> token usage, bucketed by time

    Response shape (both endpoints):
    {
      "data": [
        {
          "starting_at": "2026-06-01T00:00:00Z",
          "ending_at":   "2026-06-02T00:00:00Z",
          "results": [ { "model": "...", ...metrics... } ]
        }
      ],
      "has_more": false,
      "next_page": null
    }

    cost_report result rows carry { "amount": "<usd string>", "currency": "USD",
    "model": ..., "cost_type": ... }. usage_report rows carry token counts
    (input/output/cache) and "model".
    """

    ADMIN_API_BASE_URL = "https://api.anthropic.com/v1/organizations"
    ANTHROPIC_VERSION = "2023-06-01"
    RATE_LIMIT_DELAY = 1  # seconds between paginated requests
    MAX_RETRIES = 3
    INITIAL_BACKOFF = 2  # seconds

    def __init__(
        self,
        api_key: str,
        user_id: str,
        provider_id: str,
        organization_id: Optional[str] = None,
    ):
        """
        Initialize Anthropic collector.

        Args:
            api_key: Anthropic Admin API key (sk-ant-admin...)
            user_id: User ID who owns this API key
            provider_id: Provider ID from database
            organization_id: Optional organization ID (for metadata only)
        """
        super().__init__(api_key, user_id)
        self.provider_id = provider_id
        self.organization_id = organization_id
        self.http_client = httpx.AsyncClient(
            base_url=self.ADMIN_API_BASE_URL,
            headers={
                "anthropic-version": self.ANTHROPIC_VERSION,
                "x-api-key": api_key,
            },
            timeout=30.0,
        )

    @property
    def provider_name(self) -> str:
        """Return the provider name."""
        return "anthropic"

    async def _make_request_with_retry(
        self,
        endpoint: str,
        params: Optional[Dict[str, Any]] = None,
        retry_count: int = 0,
    ) -> Dict[str, Any]:
        """
        Make a GET API request with exponential backoff retry logic.

        Args:
            endpoint: API endpoint path (relative to base)
            params: Query parameters
            retry_count: Current retry attempt

        Returns:
            Dict: Response JSON

        Raises:
            Exception: If all retries fail
        """
        try:
            response = await self.http_client.get(endpoint, params=params)
            response.raise_for_status()
            return response.json()

        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            if status == 429 and retry_count < self.MAX_RETRIES:
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(
                    f"Rate limit hit, backing off for {backoff_time}s "
                    f"(attempt {retry_count + 1}/{self.MAX_RETRIES})"
                )
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(endpoint, params, retry_count + 1)

            elif status >= 500 and retry_count < self.MAX_RETRIES:
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(
                    f"Server error {status}, retrying in {backoff_time}s"
                )
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(endpoint, params, retry_count + 1)

            else:
                self.logger.error(f"API request failed: {status} - {e.response.text}")
                raise

        except Exception as e:
            if retry_count < self.MAX_RETRIES:
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(f"Request failed: {str(e)}, retrying in {backoff_time}s")
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(endpoint, params, retry_count + 1)
            raise

    async def _fetch_paginated(
        self,
        endpoint: str,
        start_time: datetime,
        end_time: datetime,
        bucket_width: str,
    ) -> List[Dict[str, Any]]:
        """
        Fetch all time-bucket rows from a paginated Admin API report endpoint.

        Returns the flattened list of bucket objects ({starting_at, ending_at,
        results: [...]}) across all pages.
        """
        all_buckets: List[Dict[str, Any]] = []
        page: Optional[str] = None

        base_params = {
            "starting_at": _to_rfc3339(start_time),
            "ending_at": _to_rfc3339(end_time),
            "bucket_width": bucket_width,
        }

        while True:
            params = dict(base_params)
            if page:
                params["page"] = page

            response = await self._make_request_with_retry(endpoint, params=params)

            buckets = response.get("data", []) or []
            all_buckets.extend(buckets)
            self.logger.info(
                f"Retrieved {len(buckets)} bucket(s) from {endpoint} "
                f"(total: {len(all_buckets)})"
            )

            page = response.get("next_page")
            if not response.get("has_more") or not page:
                break

            await asyncio.sleep(self.RATE_LIMIT_DELAY)

        return all_buckets

    async def fetch_usage_report(
        self,
        start_time: datetime,
        end_time: datetime,
        bucket_width: str = "1d",
    ) -> List[Dict[str, Any]]:
        """Fetch token usage buckets from GET /usage_report/messages."""
        self.logger.info(
            f"Fetching usage report from {start_time.isoformat()} to "
            f"{end_time.isoformat()} (bucket_width={bucket_width})"
        )
        return await self._fetch_paginated(
            "/usage_report/messages", start_time, end_time, bucket_width
        )

    async def fetch_cost_report(
        self,
        start_time: datetime,
        end_time: datetime,
        bucket_width: str = "1d",
    ) -> List[Dict[str, Any]]:
        """Fetch USD cost buckets from GET /cost_report."""
        self.logger.info(
            f"Fetching cost report from {start_time.isoformat()} to "
            f"{end_time.isoformat()} (bucket_width={bucket_width})"
        )
        return await self._fetch_paginated(
            "/cost_report", start_time, end_time, bucket_width
        )

    def transform_to_cost_records(
        self,
        usage_buckets: List[Dict[str, Any]],
        cost_buckets: List[Dict[str, Any]],
        bucket_width: str = "1d",
    ) -> List[Dict[str, Any]]:
        """
        Transform Admin API usage + cost buckets into cost_records rows.

        Merges by (bucket start_time, model): usage rows contribute token counts
        and request counts; cost rows contribute USD amounts. Emits one record
        per (bucket, model) seen in either report.
        """
        # Accumulate cost USD by (bucket_start, model)
        cost_map: Dict[Tuple[str, str], float] = {}
        for bucket in cost_buckets:
            bucket_start = bucket.get("starting_at")
            for row in bucket.get("results", []) or []:
                model = row.get("model") or "unknown"
                amount = _to_float(row.get("amount"))
                cost_map[(bucket_start, model)] = cost_map.get((bucket_start, model), 0.0) + amount

        # Accumulate usage by (bucket_start, model)
        usage_map: Dict[Tuple[str, str], Dict[str, int]] = {}
        for bucket in usage_buckets:
            bucket_start = bucket.get("starting_at")
            for row in bucket.get("results", []) or []:
                model = row.get("model") or "unknown"
                key = (bucket_start, model)
                agg = usage_map.setdefault(
                    key, {"input": 0, "output": 0, "requests": 0}
                )
                agg["input"] += _input_tokens(row)
                agg["output"] += int(row.get("output_tokens", 0) or 0)
                agg["requests"] += int(row.get("request_count", 0) or 0)

        records: List[Dict[str, Any]] = []
        all_keys = set(cost_map) | set(usage_map)
        for (bucket_start, model) in all_keys:
            timestamp = _parse_ts(bucket_start)
            if timestamp is None:
                self.logger.warning(f"Skipping bucket with unparseable start: {bucket_start}")
                continue

            usage = usage_map.get((bucket_start, model), {"input": 0, "output": 0, "requests": 0})
            input_tokens = usage["input"]
            output_tokens = usage["output"]
            request_count = usage["requests"] or 1

            records.append({
                "user_id": self.user_id,
                "provider_id": self.provider_id,
                "timestamp": timestamp.isoformat(),
                "model_name": model,
                "cost_usd": float(cost_map.get((bucket_start, model), 0.0)),
                "tokens_used": input_tokens + output_tokens,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "request_count": request_count,
                "collection_method": "api_automated",
                "metadata": {
                    "provider": "anthropic",
                    "bucket_width": bucket_width,
                    "organization_id": self.organization_id,
                },
            })

        self.logger.info(f"Transformed {len(records)} records")
        return records

    async def collect_data(
        self,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        backfill: bool = False,
        bucket_width: str = "1d",
    ) -> List[Dict[str, Any]]:
        """
        Collect cost data from the Anthropic Admin API.

        Args:
            start_time: Start of collection period (defaults to 24h ago)
            end_time: End of collection period (defaults to now)
            backfill: If True, default window is 90 days
            bucket_width: Time bucket granularity (1m, 1h, 1d)

        Returns:
            List of cost_records dicts ready for insertion.
        """
        if end_time is None:
            end_time = datetime.now(timezone.utc)

        if start_time is None:
            if backfill:
                start_time = end_time - timedelta(days=90)
                self.logger.info("Backfill mode: collecting last 90 days of data")
            else:
                start_time = end_time - timedelta(hours=24)

        try:
            usage_task = self.fetch_usage_report(start_time, end_time, bucket_width)
            cost_task = self.fetch_cost_report(start_time, end_time, bucket_width)
            usage_buckets, cost_buckets = await asyncio.gather(usage_task, cost_task)

            records = self.transform_to_cost_records(usage_buckets, cost_buckets, bucket_width)
            self.logger.info(
                f"Successfully collected {len(records)} records from Anthropic Admin API "
                f"({start_time.isoformat()} to {end_time.isoformat()})"
            )
            return records

        except Exception as e:
            self.logger.error(f"Failed to collect Anthropic data: {str(e)}")
            raise

    async def backfill_historical_data(self, days: int = 90) -> Dict[str, Any]:
        """Backfill historical data from the Anthropic Admin API."""
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
                "end_time": end_time.isoformat(),
            }
        except Exception as e:
            self.logger.error(f"Backfill failed: {str(e)}")
            return {"status": "error", "provider": self.provider_name, "error": str(e)}

    async def close(self):
        """Close HTTP client connection."""
        await self.http_client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()


# ---------------------------------------------------------------------------
# Module-level parsing helpers (pure, easily unit-testable)
# ---------------------------------------------------------------------------

def _to_rfc3339(dt: datetime) -> str:
    """Serialize a datetime to RFC3339 with a trailing Z for UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    """Parse an RFC3339 timestamp string into a tz-aware datetime."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def _to_float(value: Any) -> float:
    """Coerce an API amount (often a string) to float, defaulting to 0.0."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _input_tokens(row: Dict[str, Any]) -> int:
    """
    Sum the various input-token fields the usage report may expose
    (uncached input + cache creation + cache read), falling back to a plain
    input_tokens field.
    """
    if "input_tokens" in row and row.get("input_tokens") is not None:
        return int(row.get("input_tokens") or 0)
    total = 0
    for field in (
        "uncached_input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ):
        total += int(row.get(field, 0) or 0)
    return total
