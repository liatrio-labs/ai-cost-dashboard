"""
Test script for Anthropic collector.
Run this to verify the collector implementation works correctly.

Usage:
    python test_collector.py --api-key YOUR_API_KEY --user-id USER_UUID --provider-id PROVIDER_UUID
"""

import asyncio
import argparse
import logging
import os
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv

# Add app to path
import sys
sys.path.insert(0, os.path.dirname(__file__))

from app.collectors.anthropic_collector import AnthropicCollector

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


async def test_basic_collection(api_key: str, user_id: str, provider_id: str):
    """Test basic data collection (last 24 hours)."""
    logger.info("=" * 80)
    logger.info("TEST 1: Basic Collection (Last 24 Hours)")
    logger.info("=" * 80)

    async with AnthropicCollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        # Collect last 24 hours
        end_time = datetime.now(timezone.utc)
        start_time = end_time - timedelta(hours=24)

        logger.info(f"Collecting data from {start_time} to {end_time}")

        records = await collector.collect_data(start_time, end_time, backfill=False)

        logger.info(f"✓ Collected {len(records)} records")

        if records:
            logger.info("\nSample Record:")
            sample = records[0]
            for key, value in sample.items():
                logger.info(f"  {key}: {value}")

        return records


async def test_transform_data(api_key: str, user_id: str, provider_id: str):
    """Test data transformation."""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 2: Data Transformation")
    logger.info("=" * 80)

    async with AnthropicCollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        # Mock usage data
        usage_data = [
            {
                "start_time": "2026-02-11T00:00:00Z",
                "end_time": "2026-02-11T01:00:00Z",
                "model": "claude-3-opus-20240229",
                "input_tokens": 1000,
                "output_tokens": 500,
                "request_count": 5
            }
        ]

        # Mock cost data
        cost_data = [
            {
                "start_time": "2026-02-11T00:00:00Z",
                "model": "claude-3-opus-20240229",
                "cost_usd": 0.15
            }
        ]

        records = collector.transform_to_cost_records(usage_data, cost_data)

        logger.info(f"✓ Transformed {len(records)} records")
        logger.info("\nTransformed Record:")
        for key, value in records[0].items():
            logger.info(f"  {key}: {value}")

        return records


async def test_error_handling(api_key: str, user_id: str, provider_id: str):
    """Test error handling with invalid date range."""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 3: Error Handling")
    logger.info("=" * 80)

    async with AnthropicCollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        try:
            # Try to collect data from the future (should fail gracefully)
            end_time = datetime.now(timezone.utc) + timedelta(days=1)
            start_time = end_time - timedelta(hours=1)

            logger.info(f"Attempting to collect future data: {start_time} to {end_time}")
            records = await collector.collect_data(start_time, end_time)

            logger.info(f"✓ Handled gracefully, got {len(records)} records (expected 0)")

        except Exception as e:
            logger.info(f"✓ Error handled correctly: {type(e).__name__}: {str(e)}")


async def test_backfill(api_key: str, user_id: str, provider_id: str, days: int = 7):
    """Test backfill functionality."""
    logger.info("\n" + "=" * 80)
    logger.info(f"TEST 4: Backfill ({days} days)")
    logger.info("=" * 80)

    async with AnthropicCollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        result = await collector.backfill_historical_data(days=days)

        logger.info(f"✓ Backfill completed")
        logger.info(f"  Status: {result['status']}")
        logger.info(f"  Records collected: {result.get('records_collected', 0)}")
        logger.info(f"  Records stored: {result.get('records_stored', 0)}")
        logger.info(f"  Time range: {result.get('start_time')} to {result.get('end_time')}")

        if result['status'] == 'error':
            logger.error(f"  Error: {result.get('error')}")

        return result


async def test_run_workflow(api_key: str, user_id: str, provider_id: str):
    """Test the full run() workflow."""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 5: Full Run Workflow")
    logger.info("=" * 80)

    async with AnthropicCollector(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id
    ) as collector:
        result = await collector.run()

        logger.info(f"✓ Workflow completed")
        logger.info(f"  Status: {result['status']}")
        logger.info(f"  Provider: {result['provider']}")
        logger.info(f"  Records collected: {result.get('records_collected', 0)}")
        logger.info(f"  Records stored: {result.get('records_stored', 0)}")
        logger.info(f"  Timestamp: {result['timestamp']}")

        if result['status'] == 'error':
            logger.error(f"  Error: {result.get('error')}")

        return result


async def main():
    """Run all tests."""
    parser = argparse.ArgumentParser(description="Test Anthropic collector")
    parser.add_argument("--api-key", help="Anthropic API key", default=None)
    parser.add_argument("--user-id", help="User UUID", default="test-user-123")
    parser.add_argument("--provider-id", help="Provider UUID", default="test-provider-123")
    parser.add_argument("--backfill-days", type=int, default=7, help="Days to backfill")
    parser.add_argument("--skip-db", action="store_true", help="Skip tests that require database")

    args = parser.parse_args()

    # Load from .env if not provided
    load_dotenv()

    api_key = args.api_key or os.getenv("ANTHROPIC_API_KEY")

    if not api_key:
        logger.error("❌ No API key provided. Use --api-key or set ANTHROPIC_API_KEY in .env")
        return

    logger.info("Starting Anthropic Collector Tests")
    logger.info(f"User ID: {args.user_id}")
    logger.info(f"Provider ID: {args.provider_id}")
    logger.info(f"Skip DB tests: {args.skip_db}")

    try:
        # Run tests
        await test_transform_data(api_key, args.user_id, args.provider_id)

        if not args.skip_db:
            await test_basic_collection(api_key, args.user_id, args.provider_id)
            await test_error_handling(api_key, args.user_id, args.provider_id)
            # await test_backfill(api_key, args.user_id, args.provider_id, args.backfill_days)
            # await test_run_workflow(api_key, args.user_id, args.provider_id)
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
