"""
Unit tests for ClaudeAIAnalyticsCollector.transform_to_cost_records.

These tests exercise the pure transform function only -- no network, no
Supabase. ``app.collectors.base.get_supabase_client`` is monkeypatched to a Mock
so the collector can be constructed offline (BaseCollector.__init__ calls it).

NOTE on the sys.modules stubs below: this package's ``app/utils/__init__.py``
eagerly imports ``app.utils.scheduler``, which imports the collector modules,
which import ``app.collectors.base`` -- a circular import that fires on any cold
import of ``app.collectors.*``. To import the collector under test in isolation
(no DB, no scheduler) we pre-register a minimal stub ``app.utils`` package that
exposes only ``get_supabase_client`` before importing anything from
``app.collectors``. This is test-only scaffolding and touches no project files.
"""

import sys
import types
from unittest.mock import Mock

import pytest


def _install_app_utils_stub():
    """Pre-seed sys.modules with a minimal app.utils to break the import cycle."""
    if "app.utils.supabase_client" in sys.modules:
        return

    # Import the real top-level ``app`` package so its on-disk __path__ stays
    # intact (needed to locate app.collectors). Only ``app.utils`` is stubbed.
    import app as app_pkg

    utils_pkg = types.ModuleType("app.utils")
    utils_pkg.__path__ = []  # mark as package
    sys.modules["app.utils"] = utils_pkg
    app_pkg.utils = utils_pkg

    supabase_stub = types.ModuleType("app.utils.supabase_client")

    def get_supabase_client():  # overridden again via monkeypatch in the fixture
        return Mock()

    supabase_stub.get_supabase_client = get_supabase_client
    sys.modules["app.utils.supabase_client"] = supabase_stub
    utils_pkg.supabase_client = supabase_stub


_install_app_utils_stub()

import app.collectors.base as base_module  # noqa: E402
from app.collectors.claude_ai_analytics_collector import (  # noqa: E402
    ClaudeAIAnalyticsCollector,
)


@pytest.fixture
def collector(monkeypatch):
    """Construct a collector with Supabase patched out.

    BaseCollector.__init__ resolves ``get_supabase_client`` from the (stubbed)
    ``app.utils.supabase_client`` module, so patch it there. Also patch the name
    on the base module if it exposes one (raising=False keeps this resilient to
    whichever binding the import chain produced).
    """
    import app.utils.supabase_client as supabase_module

    monkeypatch.setattr(
        supabase_module, "get_supabase_client", lambda: Mock(), raising=False
    )
    monkeypatch.setattr(
        base_module, "get_supabase_client", lambda: Mock(), raising=False
    )
    return ClaudeAIAnalyticsCollector(
        api_key="test-key",
        user_id="user-123",
        provider_id="provider-abc",
        organization_id="org-xyz",
    )


@pytest.fixture
def cost_buckets():
    """Sample cost_report buckets. Amounts are in fractional cents."""
    return [
        {
            "starting_at": "2026-06-23T00:00:00Z",
            "ending_at": "2026-06-24T00:00:00Z",
            "results": [
                {
                    "model": "claude-sonnet-4-5",
                    "product": "claude_code",
                    "cost_type": "tokens",
                    "currency": "USD",
                    "amount": 1500,  # $15.00
                    "list_amount": 3000,  # $30.00
                },
                {
                    # No model -> must fall back to "claude-ai", never None.
                    "model": None,
                    "product": "claude_chat",
                    "currency": "USD",
                    "amount": 250,  # $2.50
                    "list_amount": None,
                },
            ],
        }
    ]


@pytest.fixture
def usage_buckets():
    """Sample usage_report buckets joined by (start, model, product)."""
    return [
        {
            "starting_at": "2026-06-23T00:00:00Z",
            "ending_at": "2026-06-24T00:00:00Z",
            "results": [
                {
                    "model": "claude-sonnet-4-5",
                    "product": "claude_code",
                    "uncached_input_tokens": 1000,
                    "cache_read_input_tokens": 200,
                    "output_tokens": 500,
                },
                # No usage for the chat result -> tokens stay None.
            ],
        }
    ]


def test_basic_transform_cost_and_model(collector, cost_buckets, usage_buckets):
    records = collector.transform_to_cost_records(cost_buckets, usage_buckets)
    assert len(records) == 2

    sonnet = next(r for r in records if r["model_name"] == "claude-sonnet-4-5")
    # 1500 fractional cents -> $15.00
    assert sonnet["cost_usd"] == pytest.approx(15.00)
    assert sonnet["metadata"]["list_amount_usd"] == pytest.approx(30.00)
    assert sonnet["collection_method"] == "api_automated"
    assert sonnet["request_count"] == 1
    assert sonnet["user_id"] == "user-123"
    assert sonnet["provider_id"] == "provider-abc"
    assert sonnet["metadata"]["provider"] == "claude-ai"
    assert sonnet["metadata"]["organization_id"] == "org-xyz"


def test_model_name_never_null(collector, cost_buckets, usage_buckets):
    records = collector.transform_to_cost_records(cost_buckets, usage_buckets)
    for r in records:
        assert r["model_name"] is not None
        assert r["model_name"] != ""
    # The result with model=None must become the "claude-ai" fallback.
    assert any(r["model_name"] == "claude-ai" for r in records)


def test_token_aggregation(collector, cost_buckets, usage_buckets):
    records = collector.transform_to_cost_records(cost_buckets, usage_buckets)
    sonnet = next(r for r in records if r["model_name"] == "claude-sonnet-4-5")
    # uncached (1000) + cache_read (200) = 1200 input
    assert sonnet["input_tokens"] == 1200
    assert sonnet["output_tokens"] == 500
    assert sonnet["tokens_used"] == 1700


def test_missing_usage_yields_none_tokens(collector, cost_buckets, usage_buckets):
    records = collector.transform_to_cost_records(cost_buckets, usage_buckets)
    chat = next(r for r in records if r["model_name"] == "claude-ai")
    assert chat["input_tokens"] is None
    assert chat["output_tokens"] is None
    assert chat["tokens_used"] is None
    assert chat["cost_usd"] == pytest.approx(2.50)
    assert chat["metadata"]["list_amount_usd"] is None


def test_timestamp_is_tz_aware_iso(collector, cost_buckets, usage_buckets):
    records = collector.transform_to_cost_records(cost_buckets, usage_buckets)
    ts = records[0]["timestamp"]
    # Re-parse and confirm tz-awareness.
    from datetime import datetime

    parsed = datetime.fromisoformat(ts)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() is not None
    assert ts.startswith("2026-06-23T00:00:00")


def test_unparseable_bucket_is_skipped(collector):
    cost = [
        {"starting_at": None, "results": [{"amount": 100}]},  # no start -> skip
        "not-a-dict",  # non-dict bucket -> skip
        {
            "starting_at": "2026-06-23T00:00:00Z",
            "results": [
                {"model": "claude-opus", "amount": 999},
                "not-a-dict-result",  # skipped
            ],
        },
    ]
    records = collector.transform_to_cost_records(cost, [])
    assert len(records) == 1
    assert records[0]["model_name"] == "claude-opus"
    assert records[0]["cost_usd"] == pytest.approx(9.99)


def test_unparseable_amount_defaults_to_zero(collector):
    cost = [
        {
            "starting_at": "2026-06-23T00:00:00Z",
            "results": [{"model": "claude-haiku", "amount": "not-a-number"}],
        }
    ]
    records = collector.transform_to_cost_records(cost, [])
    assert len(records) == 1
    assert records[0]["cost_usd"] == 0.0


def test_empty_input(collector):
    assert collector.transform_to_cost_records([], []) == []
    assert collector.transform_to_cost_records(None, None) == []
