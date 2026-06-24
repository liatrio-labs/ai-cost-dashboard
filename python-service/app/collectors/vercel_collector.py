"""
Vercel billing/usage data collector.

Collects team billing COST data from the Vercel REST API.

Endpoint used (verified against the Vercel REST API docs):
    GET https://api.vercel.com/v1/billing/charges
    Doc: https://vercel.com/docs/rest-api/billing/list-focus-billing-charges
    Changelog: https://vercel.com/changelog/access-billing-usage-cost-data-api

Unlike Anthropic's cost_report (which returns clean per-model USD), Vercel
returns billing data in the open FOCUS v1.3 standard, streamed as
newline-delimited JSON (JSONL). Each line is one charge record. Crucially,
this endpoint DOES expose real dollar amounts (``BilledCost`` /
``EffectiveCost`` in ``BillingCurrency`` = USD), so ``cost_usd`` can be
populated with the actual billed cost and ``metadata.cost_known`` is True.

Request details (verified):
    - Auth: ``Authorization: Bearer <VERCEL_TOKEN>`` (HTTP bearer).
    - Query params:
        * ``from`` (required): inclusive start, ISO 8601 date-time string, UTC.
        * ``to``   (required): exclusive end, ISO 8601 date-time string, UTC.
        * ``teamId`` (optional): Team identifier to act on behalf of.
        * ``slug``   (optional): Team slug (alternative to teamId).
    - Granularity: 1 day. Max date range: 1 year.
    - Access: only Pro/Enterprise teams, and only Owner/Member/Developer/
      Security/Billing/Enterprise Viewer roles.
    - Response: Content-Type ``application/jsonl`` (one JSON object per line).
      May be gzip-compressed if ``Accept-Encoding: gzip`` is sent; we do NOT
      request gzip so we can parse the text body line-by-line.

Verified FOCUS v1.3 charge record fields (subset we rely on):
    {
      "BilledCost": 12.34,              # USD amount that is invoiced
      "EffectiveCost": 10.00,           # amortized cost (discounts/credits)
      "BillingCurrency": "USD",
      "ChargeCategory": "Usage",        # Adjustment|Credit|Purchase|Tax|Usage
      "ChargePeriodStart": "2026-06-23T00:00:00Z",
      "ChargePeriodEnd":   "2026-06-24T00:00:00Z",
      "ConsumedQuantity": 1234.0,       # nullable
      "ConsumedUnit": "GB",             # nullable
      "ServiceName": "Edge Functions",  # display name of the service/product
      "ServiceCategory": "Compute",
      "ServiceProviderName": "Vercel",
      "PricingQuantity": 1234.0,
      "PricingUnit": "GB",
      "Tags": {"ProjectId": "...", "ProjectName": "..."}
    }

ASSUMPTIONS NEEDING LIVE VERIFICATION (no live Pro/Enterprise token at build
time):
    - The exact JSONL line shape above is taken from the published OpenAPI
      schema; field presence per-line may vary by ChargeCategory (e.g. Tax/
      Credit rows may omit ConsumedQuantity/ConsumedUnit). Parsing is therefore
      defensive and tolerates missing keys.
    - We assume the body is plain JSONL text (we do not send Accept-Encoding:
      gzip). If a future default changes this, decoding would need adjusting.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Any, Optional
import json
import logging
import httpx

from app.collectors.base import BaseCollector

logger = logging.getLogger(__name__)


class VercelCollector(BaseCollector):
    """
    Collector for Vercel team billing/usage cost via the REST API.

    Uses the following endpoint:
    - GET /v1/billing/charges  (FOCUS v1.3 JSONL billing charges)
      https://vercel.com/docs/rest-api/billing/list-focus-billing-charges

    Features:
    - Bearer token auth, team-scoped via teamId query param.
    - Exponential backoff retry on 429/5xx errors.
    - Defensive JSONL parsing (one charge per line).
    - Real USD cost via FOCUS ``BilledCost`` (metadata.cost_known=True).
    - Backfill for historical data (up to the API's 1-year max range).
    """

    BASE_URL = "https://api.vercel.com"
    BILLING_CHARGES_ENDPOINT = "/v1/billing/charges"
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
        Initialize Vercel collector.

        Args:
            api_key: Vercel API token (used as Bearer credential).
            user_id: User ID who owns this API key.
            provider_id: Provider ID from database.
            team_id: Optional Vercel Team ID. Team-scoped billing requests
                require this; when provided it is sent as a default query
                param on every request.
        """
        super().__init__(api_key, user_id)
        self.provider_id = provider_id
        self.team_id = team_id

        # Default query params: include teamId when scoping to a team.
        default_params: Dict[str, str] = {}
        if team_id:
            default_params["teamId"] = team_id

        self.http_client = httpx.AsyncClient(
            base_url=self.BASE_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/jsonl",
            },
            params=default_params,
            timeout=60.0,
        )

    @property
    def provider_name(self) -> str:
        """Return the provider name."""
        return "vercel"

    async def _make_request_with_retry(
        self,
        method: str,
        endpoint: str,
        params: Optional[Dict[str, Any]] = None,
        retry_count: int = 0,
    ) -> httpx.Response:
        """
        Make an API request with exponential backoff retry logic.

        Returns the raw httpx.Response (not parsed JSON) because the billing
        endpoint streams JSONL rather than a single JSON document.

        Args:
            method: HTTP method (GET).
            endpoint: API endpoint path.
            params: Query parameters (merged with default teamId param).
            retry_count: Current retry attempt.

        Returns:
            httpx.Response: The successful response.

        Raises:
            Exception: If all retries fail.
        """
        try:
            if method == "GET":
                response = await self.http_client.get(endpoint, params=params)
            else:
                response = await self.http_client.request(method, endpoint, params=params)

            response.raise_for_status()
            return response

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
                    method, endpoint, params, retry_count + 1
                )

            elif e.response.status_code >= 500 and retry_count < self.MAX_RETRIES:
                # Server error - retry with backoff
                backoff_time = self.INITIAL_BACKOFF * (2 ** retry_count)
                self.logger.warning(
                    f"Server error {e.response.status_code}, retrying in {backoff_time}s"
                )
                await asyncio.sleep(backoff_time)
                return await self._make_request_with_retry(
                    method, endpoint, params, retry_count + 1
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
                    method, endpoint, params, retry_count + 1
                )
            raise

    @staticmethod
    def _parse_jsonl(body: str) -> List[Dict[str, Any]]:
        """
        Parse a JSONL (newline-delimited JSON) body into a list of dicts.

        Defensive: skips blank lines and any line that fails to parse rather
        than aborting the whole batch.

        Args:
            body: Raw response text in JSONL format.

        Returns:
            List of parsed charge records.
        """
        records: List[Dict[str, Any]] = []
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                logger.warning("Skipping unparseable JSONL line from Vercel billing")
                continue
            if isinstance(obj, dict):
                records.append(obj)
        return records

    async def fetch_billing_charges(
        self,
        start_time: datetime,
        end_time: datetime,
    ) -> List[Dict[str, Any]]:
        """
        Fetch FOCUS v1.3 billing charges from the Vercel REST API.

        Args:
            start_time: Inclusive start of range (UTC).
            end_time: Exclusive end of range (UTC).

        Returns:
            List of FOCUS charge records (parsed from JSONL).

        Doc: https://vercel.com/docs/rest-api/billing/list-focus-billing-charges
        """
        params = {
            "from": start_time.isoformat(),
            "to": end_time.isoformat(),
        }

        self.logger.info(
            f"Fetching Vercel billing charges from {params['from']} to {params['to']}"
            + (f" for team {self.team_id}" if self.team_id else "")
        )

        response = await self._make_request_with_retry(
            "GET",
            self.BILLING_CHARGES_ENDPOINT,
            params=params,
        )

        charges = self._parse_jsonl(response.text)
        self.logger.info(f"Retrieved {len(charges)} Vercel billing charge records")
        return charges

    def transform_to_cost_records(
        self,
        charges: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Transform Vercel FOCUS billing charges to the cost_records schema.

        Each FOCUS charge line becomes one cost record. Real USD cost is taken
        from ``BilledCost`` (falling back to ``EffectiveCost``); since the
        endpoint exposes dollars, ``metadata.cost_known`` is True for records
        where a numeric cost was present, and False otherwise.

        Args:
            charges: List of FOCUS v1.3 charge records (from JSONL).

        Returns:
            List of records matching the cost_records schema.
        """
        transformed_records: List[Dict[str, Any]] = []

        for charge in charges:
            if not isinstance(charge, dict):
                continue

            # --- Cost (real USD) -------------------------------------------
            billed = charge.get("BilledCost")
            if billed is None:
                billed = charge.get("EffectiveCost")

            cost_known = isinstance(billed, (int, float))
            try:
                cost_usd = float(billed) if cost_known else 0.0
            except (TypeError, ValueError):
                cost_usd = 0.0
                cost_known = False

            # --- Timestamp (use the charge period start) -------------------
            raw_ts = charge.get("ChargePeriodStart") or charge.get("ChargePeriodEnd")
            timestamp_str: Optional[str] = None
            if isinstance(raw_ts, str) and raw_ts:
                try:
                    parsed = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                    timestamp_str = parsed.isoformat()
                except (ValueError, AttributeError):
                    self.logger.warning(
                        f"Failed to parse Vercel charge timestamp: {raw_ts}"
                    )
            if timestamp_str is None:
                timestamp_str = datetime.now(timezone.utc).isoformat()

            # --- model_name (NEVER null) -----------------------------------
            # Use the FOCUS ServiceName as the closest analog to a "model";
            # fall back to ServiceCategory, then the literal "vercel".
            model_name = (
                charge.get("ServiceName")
                or charge.get("ServiceCategory")
                or "vercel"
            )
            if not isinstance(model_name, str) or not model_name:
                model_name = "vercel"

            # --- Usage quantity (for metadata) -----------------------------
            quantity = charge.get("ConsumedQuantity")
            if quantity is None:
                quantity = charge.get("PricingQuantity")
            unit = charge.get("ConsumedUnit") or charge.get("PricingUnit")

            # Pull project info out of FOCUS Tags when present.
            tags = charge.get("Tags") if isinstance(charge.get("Tags"), dict) else {}

            record = {
                "user_id": self.user_id,
                "provider_id": self.provider_id,
                "timestamp": timestamp_str,
                "model_name": model_name,
                "cost_usd": cost_usd,
                "tokens_used": None,
                "input_tokens": None,
                "output_tokens": None,
                "request_count": 1,
                "collection_method": "api_automated",
                "metadata": {
                    "provider": "vercel",
                    "team_id": self.team_id,
                    "metric": model_name,
                    "quantity": quantity,
                    "unit": unit,
                    "cost_known": cost_known,
                    "charge_category": charge.get("ChargeCategory"),
                    "service_category": charge.get("ServiceCategory"),
                    "billing_currency": charge.get("BillingCurrency"),
                    "effective_cost": charge.get("EffectiveCost"),
                    "charge_period_start": charge.get("ChargePeriodStart"),
                    "charge_period_end": charge.get("ChargePeriodEnd"),
                    "project_id": tags.get("ProjectId"),
                    "project_name": tags.get("ProjectName"),
                },
            }

            transformed_records.append(record)

        self.logger.info(f"Transformed {len(transformed_records)} Vercel records")
        return transformed_records

    async def collect_data(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        backfill: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Collect billing/usage cost data from the Vercel REST API.

        Args:
            start_date: Start of collection period (defaults to ~1 day ago).
            end_date: End of collection period (defaults to now).
            backfill: If True, default the start to 90 days ago.

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
                # Regular collection: last ~1 day (1-day granularity).
                start_date = end_date - timedelta(days=1)

        try:
            charges = await self.fetch_billing_charges(start_date, end_date)
            records = self.transform_to_cost_records(charges)

            self.logger.info(
                f"Successfully collected {len(records)} records from Vercel API "
                f"({start_date.isoformat()} to {end_date.isoformat()})"
            )
            return records

        except Exception as e:
            self.logger.error(f"Failed to collect Vercel data: {str(e)}")
            raise

    async def backfill_historical_data(self, days: int = 90) -> Dict[str, Any]:
        """
        Backfill historical data from the Vercel API.

        Args:
            days: Number of days to backfill (Vercel max range is 1 year).

        Returns:
            Summary of the backfill operation.
        """
        end_time = datetime.now(timezone.utc)
        start_time = end_time - timedelta(days=days)

        self.logger.info(f"Starting backfill for {days} days of Vercel data")

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
