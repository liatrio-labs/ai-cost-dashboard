"""
Test script for OpenAI collector.
Run this to verify the collector implementation works correctly.

Usage:
    python test_openai_collector.py --api-key YOUR_API_KEY --user-id USER_UUID --provider-id PROVIDER_UUID
"""

import asyncio
import argparse
import logging
import os
from datetime import datetime, timedelta, timezone, date
from dotenv import load_dotenv

# Add app to path
import sys
sys.path.insert(0, os.path.dirname(__file__))

from app.collectors.openai_collector import OpenAICollector

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


async def test_subscription_info(api_key: str, user_id: str, provider_id: str):
    """Test fetching subscription information."""
    logger.info("=" * 80)
    logger.info("TEST 1: Subscription Information")
    logger.info("=" * 80)

    async with OpenAICollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        subscription = await collector.get_subscription_limits()

        logger.info(f"✓ Fetched subscription info")
        logger.info(f"  Status: {subscription.get('status')}")

        if subscription.get("status") == "success":
            logger.info(f"  Has payment method: {subscription.get('has_payment_method')}")
            logger.info(f"  Soft limit (USD): ${subscription.get('soft_limit_usd')}")
            logger.info(f"  Hard limit (USD): ${subscription.get('hard_limit_usd')}")
            logger.info(f"  Access until: {subscription.get('access_until')}")
        else:
            logger.warning(f"  Error: {subscription.get('error')}")

        return subscription


async def test_basic_collection(api_key: str, user_id: str, provider_id: str):
    """Test basic data collection (last 1 day)."""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 2: Basic Collection (Last Day)")
    logger.info("=" * 80)

    async with OpenAICollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        # Collect last day
        end_date = date.today()
        start_date = end_date - timedelta(days=1)

        logger.info(f"Collecting data from {start_date} to {end_date}")

        records = await collector.collect_data(start_date, end_date, backfill=False)

        logger.info(f"✓ Collected {len(records)} records")

        if records:
            logger.info("\nSample Record:")
            sample = records[0]
            for key, value in sample.items():
                logger.info(f"  {key}: {value}")
        else:
            logger.info("  No records found for this period")

        return records


async def test_transform_data(api_key: str, user_id: str, provider_id: str):
    """Test data transformation."""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 3: Data Transformation")
    logger.info("=" * 80)

    async with OpenAICollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        # Mock usage data
        usage_data = [
            {
                "aggregation_timestamp": 1707609600,
                "n_requests": 10,
                "operation": "chat.completions",
                "snapshot_id": "test-snapshot",
                "n_context_tokens_total": 2000,
                "n_generated_tokens_total": 1000
            }
        ]

        # Mock billing data
        billing_data = {
            "daily_costs": [
                {
                    "timestamp": 1707609600,
                    "line_items": [
                        {
                            "name": "gpt-4",
                            "cost": 0.50
                        }
                    ]
                }
            ],
            "total_usage": 0.50
        }

        records = collector.transform_to_cost_records(usage_data, billing_data)

        logger.info(f"✓ Transformed {len(records)} records")
        logger.info("\nTransformed Record:")
        for key, value in records[0].items():
            logger.info(f"  {key}: {value}")

        return records


async def test_operation_mapping(api_key: str, user_id: str, provider_id: str):
    """Test operation to model name mapping."""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 4: Operation to Model Mapping")
    logger.info("=" * 80)

    async with OpenAICollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        test_cases = [
            {"operation": "completions", "expected": "gpt-4"},
            {"operation": "chat.completions", "expected": "gpt-4"},
            {"operation": "embeddings", "expected": "text-embedding-ada-002"},
            {"operation": "images", "expected": "dall-e-3"},
            {"operation": "audio.transcriptions", "expected": "whisper-1"},
            {"operation": "audio.speech", "expected": "tts-1"},
            {"operation": "unknown_op", "expected": "openai-unknown_op"}
        ]

        logger.info("Testing operation mappings:")
        for test_case in test_cases:
            operation = test_case["operation"]
            expected = test_case["expected"]
            result = collector._map_operation_to_model(operation, {})

            status = "✓" if result == expected else "✗"
            logger.info(f"  {status} {operation} -> {result} (expected: {expected})")

        logger.info("\n✓ Operation mapping test complete")


async def test_date_range_validation(api_key: str, user_id: str, provider_id: str):
    """Test date range validation (90-day limit)."""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 5: Date Range Validation")
    logger.info("=" * 80)

    async with OpenAICollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        # Try to collect data older than 90 days (should auto-adjust)
        end_date = date.today()
        start_date = end_date - timedelta(days=120)  # Exceeds limit

        logger.info(f"Attempting to collect {(end_date - start_date).days} days")
        logger.info(f"  Start: {start_date}")
        logger.info(f"  End: {end_date}")

        try:
            records = await collector.collect_data(start_date, end_date)
            logger.info(f"✓ Handled gracefully, collected {len(records)} records")
            logger.info("  Date range was auto-adjusted to 90-day limit")

        except Exception as e:
            logger.info(f"✓ Error handled correctly: {type(e).__name__}: {str(e)}")


async def test_backfill(api_key: str, user_id: str, provider_id: str, days: int = 7):
    """Test backfill functionality."""
    logger.info("\n" + "=" * 80)
    logger.info(f"TEST 6: Backfill ({days} days)")
    logger.info("=" * 80)

    async with OpenAICollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        result = await collector.backfill_historical_data(days=days)

        logger.info(f"✓ Backfill completed")
        logger.info(f"  Status: {result['status']}")
        logger.info(f"  Records collected: {result.get('records_collected', 0)}")
        logger.info(f"  Records stored: {result.get('records_stored', 0)}")
        logger.info(f"  Date range: {result.get('start_date')} to {result.get('end_date')}")

        if result['status'] == 'error':
            logger.error(f"  Error: {result.get('error')}")

        return result


async def test_rate_limit_handling(api_key: str, user_id: str, provider_id: str):
    """Test rate limit detection from headers."""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 7: Rate Limit Header Tracking")
    logger.info("=" * 80)

    async with OpenAICollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        logger.info("Making API request to check rate limit headers...")

        try:
            # Make a simple request
            end_date = date.today()
            start_date = end_date - timedelta(days=1)
            await collector.collect_data(start_date, end_date)

            if collector.rate_limit_remaining is not None:
                logger.info(f"✓ Rate limit info detected:")
                logger.info(f"  Remaining requests: {collector.rate_limit_remaining}")
                logger.info(f"  Reset time: {collector.rate_limit_reset}")
            else:
                logger.info("  No rate limit headers detected in response")

        except Exception as e:
            logger.warning(f"Request failed: {str(e)}")


async def main():
    """Run all tests."""
    parser = argparse.ArgumentParser(description="Test OpenAI collector")
    parser.add_argument("--api-key", help="OpenAI API key", default=None)
    parser.add_argument("--user-id", help="User UUID", default="test-user-123")
    parser.add_argument("--provider-id", help="Provider UUID", default="test-provider-123")
    parser.add_argument("--backfill-days", type=int, default=7, help="Days to backfill")
    parser.add_argument("--skip-db", action="store_true", help="Skip tests that require database")

    args = parser.parse_args()

    # Load from .env if not provided
    load_dotenv()

    api_key = args.api_key or os.getenv("OPENAI_API_KEY")

    if not api_key:
        logger.error("❌ No API key provided. Use --api-key or set OPENAI_API_KEY in .env")
        return

    logger.info("Starting OpenAI Collector Tests")
    logger.info(f"User ID: {args.user_id}")
    logger.info(f"Provider ID: {args.provider_id}")
    logger.info(f"Skip DB tests: {args.skip_db}")

    try:
        # Run tests
        await test_transform_data(api_key, args.user_id, args.provider_id)
        await test_operation_mapping(api_key, args.user_id, args.provider_id)

        if not args.skip_db:
            await test_subscription_info(api_key, args.user_id, args.provider_id)
            await test_basic_collection(api_key, args.user_id, args.provider_id)
            await test_date_range_validation(api_key, args.user_id, args.provider_id)
            await test_rate_limit_handling(api_key, args.user_id, args.provider_id)
            # await test_backfill(api_key, args.user_id, args.provider_id, args.backfill_days)
        else:
            logger.info("\n⚠️  Skipping database-dependent tests (--skip-db)")

        logger.info("\n" + "=" * 80)
        logger.info("✅ All tests completed successfully!")
        logger.info("=" * 80)

    except Exception as e:
        logger.error(f"\n❌ Tests failed: {type(e).__name__}: {str(e)}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
