"""
Unit tests for OpenAICollector.transform_to_cost_records (pure, no network).

Validates the Costs (authoritative USD) + Usage (tokens) merge.
"""
from unittest.mock import Mock, patch

import pytest

from app.collectors.openai_collector import (
    OpenAICollector,
    _date_to_unix,
    _unix_to_dt,
    _to_float,
)
from datetime import date


def _make_collector():
    with patch("app.utils.supabase_client.get_supabase_client", return_value=Mock()):
        return OpenAICollector(
            api_key="sk-admin-test",
            user_id="user-1",
            provider_id="prov-openai",
            organization_id="org-1",
        )


BUCKET_UNIX = _date_to_unix(date(2026, 6, 1))


def test_cost_with_matching_usage():
    collector = _make_collector()
    cost = [{
        "start_time": BUCKET_UNIX,
        "results": [{
            "line_item": "gpt-4o",
            "amount": {"value": 0.06, "currency": "usd"},
            "project_id": "proj-1",
        }],
    }]
    usage = [{
        "start_time": BUCKET_UNIX,
        "results": [{
            "model": "gpt-4o",
            "input_tokens": 1500,
            "output_tokens": 500,
            "num_model_requests": 10,
        }],
    }]

    records = collector.transform_to_cost_records(cost, usage)
    assert len(records) == 1
    r = records[0]
    assert r["model_name"] == "gpt-4o"
    assert r["cost_usd"] == pytest.approx(0.06)
    assert r["input_tokens"] == 1500
    assert r["output_tokens"] == 500
    assert r["tokens_used"] == 2000
    assert r["request_count"] == 10
    assert r["collection_method"] == "api_automated"
    assert r["metadata"]["line_item"] == "gpt-4o"
    assert r["metadata"]["project_id"] == "proj-1"
    assert r["timestamp"].startswith("2026-06-01")


def test_cost_without_matching_usage_has_null_tokens():
    collector = _make_collector()
    cost = [{
        "start_time": BUCKET_UNIX,
        "results": [{"line_item": "web search tool", "amount": {"value": 2.5}}],
    }]
    records = collector.transform_to_cost_records(cost, [])
    assert len(records) == 1
    r = records[0]
    assert r["cost_usd"] == pytest.approx(2.5)
    assert r["tokens_used"] is None
    assert r["input_tokens"] is None
    assert r["request_count"] == 1


def test_model_name_defaults_when_line_item_missing():
    collector = _make_collector()
    cost = [{"start_time": BUCKET_UNIX, "results": [{"amount": {"value": 1.0}}]}]
    records = collector.transform_to_cost_records(cost, [])
    assert records[0]["model_name"] == "openai"


def test_bad_bucket_timestamp_skipped():
    collector = _make_collector()
    cost = [{"start_time": "not-a-unix", "results": [{"line_item": "x", "amount": {"value": 1}}]}]
    assert collector.transform_to_cost_records(cost, []) == []


def test_helpers():
    assert _to_float(0.06) == 0.06
    assert _to_float(None) == 0.0
    assert _unix_to_dt(BUCKET_UNIX).year == 2026
    assert _unix_to_dt("bad") is None
