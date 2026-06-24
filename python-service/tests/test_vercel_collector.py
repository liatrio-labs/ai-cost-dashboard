"""
Unit tests for VercelCollector.transform_to_cost_records.

These tests are pure: no network and no Supabase. We mock the Supabase client
so the collector can be constructed fully offline, then feed a sample FOCUS
v1.3 billing-charge response (matching the verified Vercel /v1/billing/charges
schema) into ``transform_to_cost_records`` and assert the emitted record shape.

Verified schema doc:
    https://vercel.com/docs/rest-api/billing/list-focus-billing-charges

NOTE ON IMPORT ISOLATION:
``BaseCollector.__init__`` does a lazy ``from app.utils.supabase_client import
get_supabase_client``. Importing that module triggers the ``app.utils`` package
``__init__``, which eagerly imports the scheduler/crypto modules (apscheduler,
cryptography, supabase). To keep these tests pure and offline — independent of
those optional deps — we install a lightweight stub for
``app.utils.supabase_client`` in ``sys.modules`` before importing the
collector. The stub exposes ``get_supabase_client`` returning a Mock, which is
exactly the Supabase mock the task requires.
"""

import sys
import types
from unittest.mock import Mock

import pytest

# --- Offline stub for the Supabase client module (see module docstring) ------
_supabase_stub = types.ModuleType("app.utils.supabase_client")
_supabase_stub.get_supabase_client = lambda: Mock()
sys.modules.setdefault("app.utils.supabase_client", _supabase_stub)

from app.collectors.vercel_collector import VercelCollector  # noqa: E402


def _make_collector():
    """Construct a VercelCollector offline with a mocked Supabase client."""
    return VercelCollector(
        api_key="test-token",
        user_id="test-user-123",
        provider_id="vercel-provider-1",
        team_id="team_abc123",
    )


# Sample FOCUS v1.3 charge records as returned (one per JSONL line) by
# GET /v1/billing/charges.
SAMPLE_CHARGES = [
    {
        "BilledCost": 12.34,
        "EffectiveCost": 10.00,
        "BillingCurrency": "USD",
        "ChargeCategory": "Usage",
        "ChargePeriodStart": "2026-06-23T00:00:00Z",
        "ChargePeriodEnd": "2026-06-24T00:00:00Z",
        "ConsumedQuantity": 1234.5,
        "ConsumedUnit": "GB",
        "ServiceName": "Edge Functions",
        "ServiceCategory": "Compute",
        "ServiceProviderName": "Vercel",
        "PricingQuantity": 1234.5,
        "PricingUnit": "GB",
        "Tags": {"ProjectId": "prj_1", "ProjectName": "my-app"},
    },
    {
        # A charge with no consumable quantity (e.g. a Tax row) and missing
        # ServiceName — exercises defensive fallbacks.
        "BilledCost": 0.99,
        "BillingCurrency": "USD",
        "ChargeCategory": "Tax",
        "ChargePeriodStart": "2026-06-23T00:00:00Z",
        "ChargePeriodEnd": "2026-06-24T00:00:00Z",
        "ConsumedQuantity": None,
        "ConsumedUnit": None,
        "ServiceCategory": "Other",
    },
]


@pytest.fixture
def collector():
    return _make_collector()


@pytest.mark.unit
def test_provider_name_is_vercel(collector):
    assert collector.provider_name == "vercel"


@pytest.mark.unit
def test_transform_returns_one_record_per_charge(collector):
    records = collector.transform_to_cost_records(SAMPLE_CHARGES)
    assert len(records) == len(SAMPLE_CHARGES)


@pytest.mark.unit
def test_model_name_never_none(collector):
    records = collector.transform_to_cost_records(SAMPLE_CHARGES)
    for r in records:
        assert r["model_name"] is not None
        assert isinstance(r["model_name"], str)
        assert r["model_name"] != ""
    # First charge uses ServiceName; second falls back to ServiceCategory.
    assert records[0]["model_name"] == "Edge Functions"
    assert records[1]["model_name"] == "Other"


@pytest.mark.unit
def test_model_name_falls_back_to_vercel_when_absent(collector):
    records = collector.transform_to_cost_records(
        [{"BilledCost": 1.0, "ChargePeriodStart": "2026-06-23T00:00:00Z"}]
    )
    assert records[0]["model_name"] == "vercel"


@pytest.mark.unit
def test_collection_method_is_api_automated(collector):
    records = collector.transform_to_cost_records(SAMPLE_CHARGES)
    for r in records:
        assert r["collection_method"] == "api_automated"


@pytest.mark.unit
def test_cost_usd_is_float(collector):
    records = collector.transform_to_cost_records(SAMPLE_CHARGES)
    for r in records:
        assert isinstance(r["cost_usd"], float)
    assert records[0]["cost_usd"] == 12.34
    assert records[1]["cost_usd"] == 0.99


@pytest.mark.unit
def test_metadata_carries_team_id_and_cost_known(collector):
    records = collector.transform_to_cost_records(SAMPLE_CHARGES)
    for r in records:
        meta = r["metadata"]
        assert meta["team_id"] == "team_abc123"
        assert "cost_known" in meta
        assert isinstance(meta["cost_known"], bool)
    # Both sample charges have a numeric BilledCost -> cost is known.
    assert records[0]["metadata"]["cost_known"] is True
    assert records[1]["metadata"]["cost_known"] is True


@pytest.mark.unit
def test_cost_known_false_when_no_numeric_cost(collector):
    records = collector.transform_to_cost_records(
        [{"ServiceName": "Blob", "ChargePeriodStart": "2026-06-23T00:00:00Z"}]
    )
    assert records[0]["cost_usd"] == 0.0
    assert records[0]["metadata"]["cost_known"] is False


@pytest.mark.unit
def test_token_fields_are_none_and_request_count_default(collector):
    records = collector.transform_to_cost_records(SAMPLE_CHARGES)
    for r in records:
        assert r["tokens_used"] is None
        assert r["input_tokens"] is None
        assert r["output_tokens"] is None
        assert r["request_count"] == 1


@pytest.mark.unit
def test_metadata_carries_quantity_and_provider(collector):
    records = collector.transform_to_cost_records(SAMPLE_CHARGES)
    assert records[0]["metadata"]["provider"] == "vercel"
    assert records[0]["metadata"]["quantity"] == 1234.5
    assert records[0]["metadata"]["unit"] == "GB"
    assert records[0]["metadata"]["project_name"] == "my-app"


@pytest.mark.unit
def test_timestamp_is_tz_aware_iso8601(collector):
    from datetime import datetime

    records = collector.transform_to_cost_records(SAMPLE_CHARGES)
    for r in records:
        parsed = datetime.fromisoformat(r["timestamp"])
        assert parsed.tzinfo is not None
