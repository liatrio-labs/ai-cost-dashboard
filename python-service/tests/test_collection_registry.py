"""
Integration tests for the collection router's provider registry and the
metadata-forwarding collector builder.

Validates that:
- the full import chain (router -> all 5 collectors -> base/utils) loads with no
  circular import, and
- _build_collector forwards only the credential-metadata kwargs each collector
  actually accepts (team_id vs organization_id), ignoring the rest.
"""
from unittest.mock import Mock

import pytest


@pytest.fixture(autouse=True)
def _offline_supabase(monkeypatch):
    monkeypatch.setattr(
        "app.utils.supabase_client.get_supabase_client", lambda: Mock()
    )


def test_all_providers_registered():
    from app.collectors import runner as col

    assert set(col.COLLECTORS) == {
        "anthropic",
        "claude-ai",
        "openai",
        "cursor",
        "vercel",
    }


def test_router_imports_without_circular_import():
    # Importing the router pulls in runner -> all 5 collectors -> base/utils.
    from app.routers import collection as router

    assert set(router.COLLECTORS) == {
        "anthropic",
        "claude-ai",
        "openai",
        "cursor",
        "vercel",
    }


def test_provider_env_reads_keys_and_scoping(monkeypatch):
    from app.collectors import runner as col

    monkeypatch.setenv("VERCEL_TOKEN", "vtok")
    monkeypatch.setenv("VERCEL_TEAM_ID", "team_9")
    api_key, metadata = col._provider_env("vercel")
    assert api_key == "vtok"
    assert metadata == {"team_id": "team_9"}


def test_run_collection_skips_when_key_missing(monkeypatch):
    import asyncio
    from app.collectors import runner as col

    monkeypatch.delenv("CURSOR_ADMIN_KEY", raising=False)
    result = asyncio.run(col.run_collection_for_provider("cursor"))
    assert result["status"] == "skipped"
    assert "CURSOR_ADMIN_KEY" in result["reason"]


def test_build_collector_forwards_team_id_to_vercel():
    from app.collectors import runner as col

    c = col._build_collector(
        col.COLLECTORS["vercel"],
        api_key="tok",
        user_id="u1",
        provider_id="pid",
        metadata={"team_id": "team_x", "unrelated": "ignored"},
    )
    assert c.team_id == "team_x"
    assert c.provider_name == "vercel"


def test_build_collector_forwards_team_id_to_cursor():
    from app.collectors import runner as col

    c = col._build_collector(
        col.COLLECTORS["cursor"], "tok", "u1", "pid", {"team_id": "t2"}
    )
    assert c.team_id == "t2"


def test_build_collector_forwards_org_id_to_claude_ai_and_ignores_team_id():
    from app.collectors import runner as col

    c = col._build_collector(
        col.COLLECTORS["claude-ai"],
        "tok",
        "u1",
        "pid",
        {"organization_id": "org_1", "team_id": "should-be-ignored"},
    )
    assert c.organization_id == "org_1"


def test_build_collector_with_empty_metadata_is_fine():
    from app.collectors import runner as col

    c = col._build_collector(col.COLLECTORS["anthropic"], "tok", "u1", "pid", {})
    assert c.provider_name == "anthropic"
