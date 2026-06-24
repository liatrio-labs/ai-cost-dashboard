"""
OpenAI organization Costs/Usage API data collector.

Uses the current organization-level endpoints (require an Admin key,
sk-admin-...):
- GET /v1/organizations/costs                 -> USD cost, daily buckets
- GET /v1/organizations/usage/completions     -> token usage, daily buckets

Replaces the deprecated /v1/usage and /v1/dashboard/billing/* endpoints.
"""

import asyncio
from datetime import datetime, timedelta, timezone, date
from typing import Dict, List, Any, Optional, Tuple
import logging
import httpx

from app.collectors.base import BaseCollector

logger = logging.getLogger(__name__)


class OpenAICollector(BaseCollector):
    """
    Collector for the OpenAI organization Costs/Usage API.

    Cost is authoritative and comes from /organizations/costs (grouped by
    line_item). Token counts come from /organizations/usage/completions
    (grouped by model) and are attached best-effort where a usage model matches
    a cost line item.

    Bucket response shape (both endpoints):
    {
      "object": "page",
      "data": [
        { "object": "bucket", "start_time": <unix>, "end_time": <unix>,
          "results": [ {...} ] }
      ],
      "has_more": false,
      "next_page": null
    }

    costs result: { "amount": {"value": 0.06, "currency": "usd"}, "line_item": "GPT-4o", "project_id": null }
    usage result: { "input_tokens": N, "output_tokens": N, "num_model_requests": N, "model": "gpt-4o" }
    """

    API_BASE_URL = "https://api.openai.com/v1/organizations"
    MAX_RETRIES = 3
    INITIAL_BACKOFF = 2  # seconds
    MAX_HISTORICAL_DAYS = 90
    RATE_LIMIT_DELAY = 1  # seconds between paginated requests

    def __init__(
        self,
        api_key: str,
        user_id: str,
        provider_id: str,
        organization_id: Optional[str] = None,
    ):
        """
        Initialize OpenAI collector.

        Args:
            api_key: OpenAI Admin API key (sk-admin-...)
            user_id: User ID who owns this API key
            provider_id: Provider ID from database
            organization_id: Optional OpenAI organization ID (metadata + header)
        """
        super().__init__(api_key, user_id)
        self.provider_id = provider_id
        self.organization_id = organization_id

        headers = {"Authorization": f"Bearer {api_key}"}
        if organization_id:
            headers["OpenAI-Organization"] = organization_id

        self.http_client = httpx.AsyncClient(
            base_url=self.API_BASE_URL,
            headers=headers,
            timeout=30.0,
        )

    @property
    def provider_name(self) -> str:
        """Return the provider name."""
        return "openai"

    async def _make_request_with_retry(
        self,
        endpoint: str,
        params: Optional[Dict[str, Any]] = None,
        retry_count: int = 0,
    ) -> Dict[str, Any]:
        """Make a GET API request with exponential backoff retry logic."""
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
                self.logger.warning(f"Server error {status}, retrying in {backoff_time}s")
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
        start_unix: int,
        end_unix: int,
        group_by: List[str],
        bucket_width: str = "1d",
    ) -> List[Dict[str, Any]]:
        """Fetch all bucket rows across pages from a Costs/Usage endpoint."""
        all_buckets: List[Dict[str, Any]] = []
        page: Optional[str] = None

        base_params: Dict[str, Any] = {
            "start_time": start_unix,
            "end_time": end_unix,
            "bucket_width": bucket_width,
            "limit": 180,
        }
        if group_by:
            base_params["group_by"] = group_by

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

    async def fetch_costs(self, start_unix: int, end_unix: int) -> List[Dict[str, Any]]:
        """Fetch USD cost buckets from GET /costs (grouped by line_item)."""
        self.logger.info(f"Fetching costs from {start_unix} to {end_unix}")
        return await self._fetch_paginated("/costs", start_unix, end_unix, ["line_item"])

    async def fetch_usage(self, start_unix: int, end_unix: int) -> List[Dict[str, Any]]:
        """Fetch token usage buckets from GET /usage/completions (grouped by model)."""
        self.logger.info(f"Fetching usage/completions from {start_unix} to {end_unix}")
        return await self._fetch_paginated(
            "/usage/completions", start_unix, end_unix, ["model"]
        )

    def transform_to_cost_records(
        self,
        cost_buckets: List[Dict[str, Any]],
        usage_buckets: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Transform Costs + Usage buckets into cost_records rows.

        Cost is authoritative: one record per (bucket, line_item). Token counts
        from the usage report are attached when a usage model matches the cost
        line item (case-insensitive); otherwise tokens are left null.
        """
        # Build usage lookup by (bucket_start_unix, model_lower)
        usage_map: Dict[Tuple[int, str], Dict[str, int]] = {}
        for bucket in usage_buckets:
            bucket_start = bucket.get("start_time")
            for row in bucket.get("results", []) or []:
                model = (row.get("model") or "").lower()
                key = (bucket_start, model)
                agg = usage_map.setdefault(key, {"input": 0, "output": 0, "requests": 0})
                agg["input"] += int(row.get("input_tokens", 0) or 0)
                agg["output"] += int(row.get("output_tokens", 0) or 0)
                agg["requests"] += int(row.get("num_model_requests", 0) or 0)

        records: List[Dict[str, Any]] = []
        for bucket in cost_buckets:
            bucket_start = bucket.get("start_time")
            timestamp = _unix_to_dt(bucket_start)
            if timestamp is None:
                self.logger.warning(f"Skipping cost bucket with bad start_time: {bucket_start}")
                continue

            for row in bucket.get("results", []) or []:
                line_item = row.get("line_item") or "openai"
                amount = row.get("amount") or {}
                cost_usd = _to_float(amount.get("value"))

                usage = usage_map.get((bucket_start, line_item.lower()))
                if usage:
                    input_tokens: Optional[int] = usage["input"]
                    output_tokens: Optional[int] = usage["output"]
                    tokens_used: Optional[int] = usage["input"] + usage["output"]
                    request_count = usage["requests"] or 1
                else:
                    input_tokens = output_tokens = tokens_used = None
                    request_count = 1

                records.append({
                    "user_id": self.user_id,
                    "provider_id": self.provider_id,
                    "timestamp": timestamp.isoformat(),
                    "model_name": line_item,
                    "cost_usd": cost_usd,
                    "tokens_used": tokens_used,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "request_count": request_count,
                    "collection_method": "api_automated",
                    "metadata": {
                        "provider": "openai",
                        "line_item": line_item,
                        "currency": amount.get("currency", "usd"),
                        "project_id": row.get("project_id"),
                        "organization_id": self.organization_id,
                    },
                })

        self.logger.info(f"Transformed {len(records)} records")
        return records

    async def collect_data(
        self,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
        backfill: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Collect cost data from the OpenAI Costs/Usage API.

        Args:
            start_date: Start date (defaults to yesterday)
            end_date: End date, exclusive upper bound (defaults to today)
            backfill: If True, default window is MAX_HISTORICAL_DAYS

        Returns:
            List of cost_records dicts ready for insertion.
        """
        if end_date is None:
            end_date = date.today()

        if start_date is None:
            if backfill:
                start_date = end_date - timedelta(days=self.MAX_HISTORICAL_DAYS)
                self.logger.info(f"Backfill mode: collecting last {self.MAX_HISTORICAL_DAYS} days")
            else:
                start_date = end_date - timedelta(days=1)

        max_start = end_date - timedelta(days=self.MAX_HISTORICAL_DAYS)
        if start_date < max_start:
            self.logger.warning(
                f"Start date {start_date} exceeds {self.MAX_HISTORICAL_DAYS}-day window; "
                f"adjusting to {max_start}"
            )
            start_date = max_start

        start_unix = _date_to_unix(start_date)
        # end_date is exclusive: include the full final day
        end_unix = _date_to_unix(end_date + timedelta(days=1))

        try:
            cost_task = self.fetch_costs(start_unix, end_unix)
            usage_task = self.fetch_usage(start_unix, end_unix)
            cost_buckets, usage_buckets = await asyncio.gather(cost_task, usage_task)

            records = self.transform_to_cost_records(cost_buckets, usage_buckets)
            self.logger.info(
                f"Successfully collected {len(records)} records from OpenAI API "
                f"({start_date} to {end_date})"
            )
            return records

        except Exception as e:
            self.logger.error(f"Failed to collect OpenAI data: {str(e)}")
            raise

    async def backfill_historical_data(self, days: int = 90) -> Dict[str, Any]:
        """Backfill historical data from the OpenAI Costs/Usage API."""
        if days > self.MAX_HISTORICAL_DAYS:
            self.logger.warning(
                f"Requested {days} days, capping to {self.MAX_HISTORICAL_DAYS}"
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
                "end_date": end_date.isoformat(),
            }
        except Exception as e:
            self.logger.error(f"Backfill failed: {str(e)}")
            return {"status": "error", "provider": self.provider_name, "error": str(e)}

    async def get_subscription_limits(self) -> Dict[str, Any]:
        """
        Subscription/billing-limit info is not exposed by the new organization
        Costs/Usage API. Retained for backward compatibility with the
        /api/collection/subscription/{provider} route.
        """
        return {
            "status": "unavailable",
            "message": (
                "Subscription limits are no longer available via the OpenAI API "
                "(deprecated /dashboard/billing/subscription endpoint)."
            ),
        }

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

def _date_to_unix(d: date) -> int:
    """Convert a date to a UTC unix-second timestamp at 00:00:00."""
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def _unix_to_dt(value: Any) -> Optional[datetime]:
    """Convert a unix-second timestamp to a tz-aware datetime."""
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def _to_float(value: Any) -> float:
    """Coerce an amount value to float, defaulting to 0.0."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
