"""
Unit tests for CursorCollector.transform_to_cost_records.

These are pure tests: no network and no Supabase. We monkeypatch
``app.collectors.base.get_supabase_client`` so the collector constructs
offline.
"""

import sys
import types
from datetime import datetime, timezone
from unittest.mock import Mock

import pytest

# These are pure transform tests: no network, no Supabase, no app wiring.
#
# Importing ``app.collectors.base`` normally drags in the whole app via
# ``app.utils.__init__`` (crypto, scheduler, supabase, ...), which both (a)
# triggers a pre-existing circular import through the scheduler and (b)
# requires many heavyweight third-party deps. ``base`` itself only needs
# ``app.utils.supabase_client.get_supabase_client`` (which we monkeypatch to a
# Mock anyway). So we pre-stub the ``app.utils`` package and its
# ``supabase_client`` submodule in ``sys.modules`` before importing. No app
# files are modified.
if "app.utils.supabase_client" not in sys.modules:
    utils_pkg = types.ModuleType("app.utils")
    utils_pkg.__path__ = []  # mark as a package
    supabase_client_stub = types.ModuleType("app.utils.supabase_client")
    supabase_client_stub.get_supabase_client = lambda: Mock()
    utils_pkg.supabase_client = supabase_client_stub
    sys.modules["app.utils"] = utils_pkg
    sys.modules["app.utils.supabase_client"] = supabase_client_stub

import app.collectors.base as base_module
from app.collectors.cursor_collector import CursorCollector


@pytest.fixture
def collector(monkeypatch):
    """Construct a CursorCollector offline with a mocked Supabase client."""
    # base imports get_supabase_client lazily from app.utils.supabase_client
    # (stubbed above in sys.modules), so patch it at its definition site.
    monkeypatch.setattr(
        sys.modules["app.utils.supabase_client"],
        "get_supabase_client",
        lambda: Mock(),
    )
    c = CursorCollector(
        api_key="test-admin-key",
        user_id="user-123",
        provider_id="provider-cursor",
        team_id="team-42",
    )
    return c


@pytest.fixture
def sample_usage():
    """Two days of usage for one member (matches verified schema)."""
    return [
        {
            "userId": 1,
            "day": "2026-06-22",
            "date": 1750550400000,
            "email": "alice@example.com",
            "isActive": True,
            "chatRequests": 5,
            "composerRequests": 2,
            "agentRequests": 1,
            "cmdkUsages": 1,
            "mostUsedModel": "claude-4-sonnet",
        },
        {
            "userId": 1,
            "day": "2026-06-23",
            "date": 1750636800000,
            "email": "alice@example.com",
            "isActive": True,
            "chatRequests": 3,
            "composerRequests": 0,
            "agentRequests": 0,
            "cmdkUsages": 0,
            "mostUsedModel": "claude-4-sonnet",
        },
    ]


@pytest.fixture
def sample_spend():
    """Spend rows (cents) for two members; one not present in usage."""
    return [
        {
            "userId": 1,
            "name": "Alice",
            "email": "alice@example.com",
            "role": "member",
            "spendCents": 4250,  # -> $42.50
            "overallSpendCents": 4250,
            "fastPremiumRequests": 100,
        },
        {
            "userId": 2,
            "name": "Bob",
            "email": "bob@example.com",
            "role": "member",
            "spendCents": 0,  # -> $0.00, no usage rows
            "overallSpendCents": 0,
            "fastPremiumRequests": 7,
        },
    ]


def test_cents_to_dollars(collector, sample_usage, sample_spend):
    records = collector.transform_to_cost_records(sample_usage, sample_spend)
    by_email = {r["metadata"]["member_email"]: r for r in records}

    assert by_email["alice@example.com"]["cost_usd"] == pytest.approx(42.50)
    assert by_email["bob@example.com"]["cost_usd"] == pytest.approx(0.0)


def test_model_name_never_null(collector, sample_usage, sample_spend):
    records = collector.transform_to_cost_records(sample_usage, sample_spend)
    by_email = {r["metadata"]["member_email"]: r for r in records}

    # Alice has a model from usage rows.
    assert by_email["alice@example.com"]["model_name"] == "claude-4-sonnet"
    # Bob has no usage rows -> falls back to "cursor", never None.
    assert by_email["bob@example.com"]["model_name"] == "cursor"
    for r in records:
        assert r["model_name"] is not None


def test_member_email_in_metadata(collector, sample_usage, sample_spend):
    records = collector.transform_to_cost_records(sample_usage, sample_spend)
    emails = {r["metadata"]["member_email"] for r in records}
    assert emails == {"alice@example.com", "bob@example.com"}


def test_collection_method_and_team_id(collector, sample_usage, sample_spend):
    records = collector.transform_to_cost_records(sample_usage, sample_spend)
    for r in records:
        assert r["collection_method"] == "api_automated"
        assert r["metadata"]["team_id"] == "team-42"
        assert r["metadata"]["provider"] == "cursor"
        assert r["provider_id"] == "provider-cursor"
        assert r["user_id"] == "user-123"


def test_request_count_aggregated_from_usage(collector, sample_usage, sample_spend):
    records = collector.transform_to_cost_records(sample_usage, sample_spend)
    by_email = {r["metadata"]["member_email"]: r for r in records}

    # Alice: day1 (5+2+1+1=9) + day2 (3) = 12
    assert by_email["alice@example.com"]["request_count"] == 12
    # Bob: no usage -> falls back to fastPremiumRequests (7)
    assert by_email["bob@example.com"]["request_count"] == 7


def test_token_fields_are_none(collector, sample_usage, sample_spend):
    records = collector.transform_to_cost_records(sample_usage, sample_spend)
    for r in records:
        assert r["tokens_used"] is None
        assert r["input_tokens"] is None
        assert r["output_tokens"] is None


def test_timestamp_is_tz_aware_iso(collector, sample_spend):
    start = datetime(2026, 6, 1, tzinfo=timezone.utc)
    end = datetime(2026, 6, 24, tzinfo=timezone.utc)
    records = collector.transform_to_cost_records([], sample_spend, start, end)

    for r in records:
        # Parses back as an aware datetime.
        parsed = datetime.fromisoformat(r["timestamp"])
        assert parsed.tzinfo is not None
        assert r["metadata"]["period_start"] == start.isoformat()
        assert r["metadata"]["period_end"] == end.isoformat()


def test_falls_back_to_overall_spend_cents(collector):
    spend = [
        {
            "email": "carol@example.com",
            "overallSpendCents": 999,  # spendCents missing
            "fastPremiumRequests": 1,
        }
    ]
    records = collector.transform_to_cost_records([], spend)
    assert records[0]["cost_usd"] == pytest.approx(9.99)


def test_skips_unparseable_spend_row(collector):
    spend = [
        {"email": "bad@example.com", "spendCents": "not-a-number"},
        {"email": "good@example.com", "spendCents": 100},
    ]
    records = collector.transform_to_cost_records([], spend)
    emails = {r["metadata"]["member_email"] for r in records}
    assert emails == {"good@example.com"}
    assert records[0]["cost_usd"] == pytest.approx(1.0)


def test_missing_request_count_defaults_to_one(collector):
    spend = [{"email": "dave@example.com", "spendCents": 500}]  # no fastPremiumRequests
    records = collector.transform_to_cost_records([], spend)
    assert records[0]["request_count"] == 1
