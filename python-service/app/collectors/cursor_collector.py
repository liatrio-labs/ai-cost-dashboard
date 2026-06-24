"""
Cursor Admin API data collector.

Collects per-member usage and spend data from Cursor's Admin API
(Cursor Business / Team plans).

Source / verified docs:
    https://cursor.com/docs/account/teams/admin-api
    (mirror: https://docs.cursor.com/en/account/teams/admin-api)

Verified API facts (as of 2026-06):
- Base URL: ``https://api.cursor.com``
- Auth: HTTP Basic with the admin API key as the *username* and an empty
  password, i.e. ``Authorization: Basic base64("<API_KEY>:")``. With httpx
  this is ``auth=(api_key, "")``.

Endpoints used:

``POST /teams/daily-usage-data``
    Request body (epoch MILLISECONDS, both required)::

        {"startDate": <int ms>, "endDate": <int ms>}

    Response (``data`` is one row per member per active day)::

        {
          "data": [
            {
              "userId": 123,
              "day": "2026-06-23",      # human-readable day
              "date": 1750636800000,    # epoch ms for the day
              "email": "user@example.com",
              "isActive": true,
              "totalLinesAdded": 100,
              "totalLinesDeleted": 10,
              "acceptedLinesAdded": 80,
              "acceptedLinesDeleted": 5,
              "totalApplies": 12,
              "totalAccepts": 9,
              "totalRejects": 3,
              "totalTabsShown": 50,
              "totalTabsAccepted": 30,
              "composerRequests": 4,
              "chatRequests": 7,
              "agentRequests": 2,
              "cmdkUsages": 1,
              "subscriptionIncludedReqs": 10,
              "apiKeyReqs": 0,
              "usageBasedReqs": 0,
              "bugbotUsages": 0,
              "mostUsedModel": "claude-4-sonnet",  # may be null
              "applyMostUsedExtension": ".py",
              "tabMostUsedExtension": ".py",
              "clientVersion": "1.2.3"
            }
          ],
          "period": {"startDate": <int ms>, "endDate": <int ms>}
        }

``POST /teams/spend``
    Request body (all optional)::

        {"page": 1, "pageSize": 100}

    Response (one row per member, NO per-day breakdown, cost in CENTS)::

        {
          "teamMemberSpend": [
            {
              "userId": 123,
              "name": "Jane Doe",
              "email": "user@example.com",
              "role": "member",
              "spendCents": 4250,            # cents -> divide by 100 for USD
              "overallSpendCents": 4250,
              "fastPremiumRequests": 321,
              "hardLimitOverrideDollars": 0,
              "monthlyLimitDollars": null
            }
          ],
          "subscriptionCycleStart": <int ms>,
          "totalMembers": 5,
          "totalPages": 1
        }

Modeling decision:
    The spend endpoint reports cumulative spend per member for the current
    billing cycle and does NOT break it down by day. We therefore emit ONE
    cost record per member for the collection period (carrying the dollar
    spend), enriched with the most-used model and aggregated request counts
    derived from the daily-usage rows for that member. The date range is
    recorded in ``metadata`` so downstream consumers can attribute it.

NOTE (needs live verification): per the Cursor community forum, ``spendCents``
may include subscription/included amounts, and newer fields such as
``includedSpendCents`` may be present but undocumented. We keep the raw
``spendCents``/``overallSpendCents`` in metadata so this can be reconciled
later without re-collecting.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Any, Optional
import logging
import httpx

from app.collectors.base import BaseCollector

logger = logging.getLogger(__name__)


class CursorCollector(BaseCollector):
    """
    Collector for the Cursor Admin API.

    Uses the following endpoints:
    - POST /teams/daily-usage-data  (per-member, per-day usage)
    - POST /teams/spend             (per-member cumulative spend, in cents)

    Features:
    - HTTP Basic auth (api_key as username, empty password)
    - Exponential backoff retry on 429 / 5xx
    - Backfill for historical data
    - Defensive parsing (missing fields, cents -> dollars, skips bad rows)
    """

    ADMIN_API_BASE_URL = "https://api.cursor.com"
    MAX_RETRIES = 3
    INITIAL_BACKOFF = 2  # seconds

    def __init__(
        self,
        api_key: str,
        user_id: str,
        provider_id: str,
        team_id: Optional[str] = None,
    ):
        """
        Initialize Cursor collector.

        Args:
            api_key: Cursor Admin API key (used as HTTP Basic username)
            user_id: User ID who owns this API key
            provider_id: Provider ID from database
            team_id: Optional Cursor team identifier (stored in metadata)
        """
        super().__init__(api_key, user_id)
        self.provider_id = provider_id
        self.team_id = team_id
        # HTTP Basic: API key as username, empty password.
        self.http_client = httpx.AsyncClient(
            base_url=self.ADMIN_API_BASE_URL,
            auth=(api_key, ""),
            timeout=30.0,
        )

    @property
    def provider_name(self) -> str:
        """Return the provider name."""
        return "cursor"

    async def _make_request_with_retry(
        self,
        method: str,
        endpoint: str,
        json_data: Optional[Dict[str, Any]] = None,
        retry_count: int = 0,
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
                    f"Rate limit hit, backing off for {backoff_time}s "
                    f"(attempt {retry_count + 1}/{self.MAX_RETRIES})"
                )
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(
                    method, endpoint, json_data, retry_count + 1
                )

            elif e.response.status_code >= 500 and retry_count < self.MAX_RETRIES:
                # Server error - retry with backoff
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(
                    f"Server error {e.response.status_code}, retrying in {backoff_time}s"
                )
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(
                    method, endpoint, json_data, retry_count + 1
                )

            else:
                self.logger.error(
                    f"API request failed: {e.response.status_code} - {e.response.text}"
                )
                raise

        except Exception as e:
            if retry_count < self.MAX_RETRIES:
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(
                    f"Request failed: {str(e)}, retrying in {backoff_time}s"
                )
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(
                    method, endpoint, json_data, retry_count + 1
                )
            raise

    async def fetch_daily_usage(
        self,
        start_time: datetime,
        end_time: datetime,
    ) -> List[Dict[str, Any]]:
        """
        Fetch per-member daily usage data.

        ``startDate`` / ``endDate`` must be epoch MILLISECONDS.

        Args:
            start_time: Start of time range (UTC)
            end_time: End of time range (UTC)

        Returns:
            List of daily-usage rows (``data`` array from the response).
        """
        start_ms = int(start_time.timestamp() * 1000)
        end_ms = int(end_time.timestamp() * 1000)

        self.logger.info(
            f"Fetching Cursor daily usage from {start_time.isoformat()} "
            f"to {end_time.isoformat()} ({start_ms}..{end_ms} ms)"
        )

        response = await self._make_request_with_retry(
            "POST",
            "/teams/daily-usage-data",
            json_data={"startDate": start_ms, "endDate": end_ms},
        )

        rows = response.get("data", []) or []
        self.logger.info(f"Retrieved {len(rows)} daily-usage rows")
        return rows

    async def fetch_spend(self) -> List[Dict[str, Any]]:
        """
        Fetch per-member spend data (cumulative for the current billing cycle).

        Returns:
            List of spend rows (``teamMemberSpend`` array from the response).
        """
        self.logger.info("Fetching Cursor team spend")

        response = await self._make_request_with_retry(
            "POST",
            "/teams/spend",
            json_data={"page": 1, "pageSize": 100},
        )

        rows = response.get("teamMemberSpend", []) or []
        self.logger.info(f"Retrieved {len(rows)} spend rows")
        return rows

    def transform_to_cost_records(
        self,
        usage_data: List[Dict[str, Any]],
        spend_data: List[Dict[str, Any]],
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """
        Transform Cursor usage + spend data into cost_records schema rows.

        Because the spend endpoint has no per-day breakdown, we emit one
        record per member for the period, carrying the member's dollar spend
        and enriching it with usage aggregated from the daily-usage rows.

        Args:
            usage_data: Rows from ``/teams/daily-usage-data`` (``data`` array).
            spend_data: Rows from ``/teams/spend`` (``teamMemberSpend`` array).
            start_time: Period start (used for the record timestamp + metadata).
            end_time: Period end (used for metadata).

        Returns:
            List of records matching the cost_records schema.
        """
        # Aggregate usage per member email so we can enrich each spend row.
        usage_by_email: Dict[str, Dict[str, Any]] = {}
        for row in usage_data:
            email = row.get("email")
            if not email:
                # Without an email we can't join to spend; skip enrichment.
                continue

            agg = usage_by_email.setdefault(
                email,
                {
                    "request_count": 0,
                    "most_used_model": None,
                    "user_id": row.get("userId"),
                },
            )

            # Sum request-like counts across days.
            for field in (
                "chatRequests",
                "composerRequests",
                "agentRequests",
                "cmdkUsages",
            ):
                try:
                    agg["request_count"] += int(row.get(field, 0) or 0)
                except (TypeError, ValueError):
                    continue

            # Keep the first non-null model we see (rows are per-day).
            if agg["most_used_model"] is None and row.get("mostUsedModel"):
                agg["most_used_model"] = row.get("mostUsedModel")

        # Timestamp for the emitted records: use the period start (tz-aware).
        if start_time is None:
            ts = datetime.now(timezone.utc)
        elif start_time.tzinfo is None:
            ts = start_time.replace(tzinfo=timezone.utc)
        else:
            ts = start_time.astimezone(timezone.utc)
        timestamp_iso = ts.isoformat()

        end_iso = None
        if end_time is not None:
            end_iso = (
                end_time.replace(tzinfo=timezone.utc).isoformat()
                if end_time.tzinfo is None
                else end_time.astimezone(timezone.utc).isoformat()
            )

        transformed_records: List[Dict[str, Any]] = []

        for spend_row in spend_data:
            email = spend_row.get("email")

            # cents -> dollars. spendCents preferred; fall back to overall.
            spend_cents = spend_row.get("spendCents")
            if spend_cents is None:
                spend_cents = spend_row.get("overallSpendCents", 0)
            try:
                cost_usd = float(spend_cents or 0) / 100.0
            except (TypeError, ValueError):
                self.logger.warning(
                    f"Skipping spend row with unparseable spendCents: {spend_row!r}"
                )
                continue

            usage_agg = usage_by_email.get(email, {})

            # model_name must NEVER be null.
            model_name = usage_agg.get("most_used_model") or "cursor"

            # Prefer per-member usage request count; fall back to
            # fastPremiumRequests from the spend row; default to 1.
            request_count = usage_agg.get("request_count") or 0
            if not request_count:
                try:
                    request_count = int(spend_row.get("fastPremiumRequests", 0) or 0)
                except (TypeError, ValueError):
                    request_count = 0
            if not request_count:
                request_count = 1

            record = {
                "user_id": self.user_id,
                "provider_id": self.provider_id,
                "timestamp": timestamp_iso,
                "model_name": model_name,
                "cost_usd": cost_usd,
                "tokens_used": None,
                "input_tokens": None,
                "output_tokens": None,
                "request_count": int(request_count),
                "collection_method": "api_automated",
                "metadata": {
                    "provider": "cursor",
                    "member_email": email,
                    "team_id": self.team_id,
                    "cursor_user_id": spend_row.get("userId")
                    or usage_agg.get("user_id"),
                    "member_name": spend_row.get("name"),
                    "member_role": spend_row.get("role"),
                    "spend_cents": spend_row.get("spendCents"),
                    "overall_spend_cents": spend_row.get("overallSpendCents"),
                    "fast_premium_requests": spend_row.get("fastPremiumRequests"),
                    "period_start": timestamp_iso,
                    "period_end": end_iso,
                },
            }

            transformed_records.append(record)

        self.logger.info(f"Transformed {len(transformed_records)} Cursor records")
        return transformed_records

    async def collect_data(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        backfill: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Collect cost data from the Cursor Admin API.

        Args:
            start_date: Start of collection period (defaults to ~1 day ago,
                or 90 days ago when backfill=True).
            end_date: End of collection period (defaults to now).
            backfill: If True, default the window to the last 90 days.

        Returns:
            List of cost records ready for database insertion.
        """
        if end_date is None:
            end_date = datetime.now(timezone.utc)

        if start_date is None:
            if backfill:
                start_date = end_date - timedelta(days=90)
                self.logger.info("Backfill mode: collecting last 90 days of data")
            else:
                start_date = end_date - timedelta(days=1)

        try:
            # Fetch usage and spend concurrently.
            usage_task = self.fetch_daily_usage(start_date, end_date)
            spend_task = self.fetch_spend()
            usage_data, spend_data = await asyncio.gather(usage_task, spend_task)

            records = self.transform_to_cost_records(
                usage_data, spend_data, start_date, end_date
            )

            self.logger.info(
                f"Successfully collected {len(records)} records from Cursor API "
                f"({start_date.isoformat()} to {end_date.isoformat()})"
            )

            return records

        except Exception as e:
            self.logger.error(f"Failed to collect Cursor data: {str(e)}")
            raise

    async def backfill_historical_data(self, days: int = 90) -> Dict[str, Any]:
        """
        Backfill historical data from the Cursor Admin API.

        Args:
            days: Number of days to backfill.

        Returns:
            Summary of the backfill operation.
        """
        end_time = datetime.now(timezone.utc)
        start_time = end_time - timedelta(days=days)

        self.logger.info(f"Starting backfill for {days} days of Cursor data")

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
            return {
                "status": "error",
                "provider": self.provider_name,
                "error": str(e),
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
