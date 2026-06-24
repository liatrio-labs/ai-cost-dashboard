"""
Unit tests for AnthropicCollector.transform_to_cost_records (pure, no network).

Validates the merge of Admin API usage + cost buckets into cost_records rows.
"""
from unittest.mock import Mock, patch

import pytest

from app.collectors.anthropic_collector import (
    AnthropicCollector,
    _input_tokens,
    _to_float,
    _to_rfc3339,
)


def _make_collector():
    with patch("app.utils.supabase_client.get_supabase_client", return_value=Mock()):
        return AnthropicCollector(
            api_key="sk-ant-admin-test",
            user_id="user-1",
            provider_id="prov-anthropic",
            organization_id="org-1",
        )


def test_merges_usage_and_cost_by_bucket_and_model():
    collector = _make_collector()
    usage = [{
        "starting_at": "2026-06-01T00:00:00Z",
        "results": [{
            "model": "claude-sonnet-4-5",
            "uncached_input_tokens": 1000,
            "cache_read_input_tokens": 200,
            "output_tokens": 500,
            "request_count": 5,
        }],
    }]
    cost = [{
        "starting_at": "2026-06-01T00:00:00Z",
        "results": [{"model": "claude-sonnet-4-5", "amount": "12.34", "currency": "USD"}],
    }]

    records = collector.transform_to_cost_records(usage, cost)
    assert len(records) == 1
    r = records[0]
    assert r["model_name"] == "claude-sonnet-4-5"
    assert r["cost_usd"] == pytest.approx(12.34)
    assert r["input_tokens"] == 1200  # 1000 uncached + 200 cache read
    assert r["output_tokens"] == 500
    assert r["tokens_used"] == 1700
    assert r["request_count"] == 5
    assert r["collection_method"] == "api_automated"
    assert r["provider_id"] == "prov-anthropic"
    assert r["timestamp"].startswith("2026-06-01")


def test_cost_only_model_has_zero_tokens_and_default_request_count():
    collector = _make_collector()
    cost = [{
        "starting_at": "2026-06-02T00:00:00Z",
        "results": [{"model": "claude-opus-4", "amount": "3.00"}],
    }]
    records = collector.transform_to_cost_records([], cost)
    assert len(records) == 1
    r = records[0]
    assert r["cost_usd"] == pytest.approx(3.00)
    assert r["tokens_used"] == 0
    assert r["request_count"] == 1


def test_model_name_never_null():
    collector = _make_collector()
    cost = [{
        "starting_at": "2026-06-03T00:00:00Z",
        "results": [{"amount": "1.00"}],  # no model field
    }]
    records = collector.transform_to_cost_records([], cost)
    assert records[0]["model_name"] == "unknown"


def test_unparseable_bucket_is_skipped():
    collector = _make_collector()
    cost = [{"starting_at": None, "results": [{"model": "x", "amount": "1"}]}]
    assert collector.transform_to_cost_records([], cost) == []


def test_helpers():
    assert _to_float("1.5") == 1.5
    assert _to_float(None) == 0.0
    assert _to_float("bad") == 0.0
    assert _input_tokens({"input_tokens": 42}) == 42
    assert _input_tokens({"uncached_input_tokens": 10, "cache_read_input_tokens": 5}) == 15
    assert _to_rfc3339.__call__  # exists/callable
