"""
Environment-driven collection runner.

Provider API keys are org-level admin keys configured as environment secrets
(not per-user DB credentials). All collected data is attributed to a single
owner user so the dashboard shows one shared, org-wide view.

Env vars per provider (api key + optional org/team scoping):
    anthropic  : ANTHROPIC_ADMIN_KEY      [, ANTHROPIC_ORG_ID]
    claude-ai  : CLAUDE_AI_ANALYTICS_KEY  [, CLAUDE_AI_ORG_ID]
    openai     : OPENAI_ADMIN_KEY         [, OPENAI_ORG_ID]
    cursor     : CURSOR_ADMIN_KEY         [, CURSOR_TEAM_ID]
    vercel     : VERCEL_TOKEN             [, VERCEL_TEAM_ID]

Owner attribution:
    DASHBOARD_OWNER_USER_ID  (auth.users UUID) takes precedence; otherwise the
    owner is resolved by email from DASHBOARD_OWNER_EMAIL (default below).
"""

import inspect
import logging
import os
from datetime import datetime
from typing import Any, Dict, Optional, Type

from app.collectors.anthropic_collector import AnthropicCollector
from app.collectors.base import BaseCollector
from app.collectors.claude_ai_analytics_collector import ClaudeAIAnalyticsCollector
from app.collectors.cursor_collector import CursorCollector
from app.collectors.openai_collector import OpenAICollector
from app.collectors.vercel_collector import VercelCollector
from app.utils.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

DEFAULT_OWNER_EMAIL = "robert@liatrio.com"

# provider name -> collector class. Keys match the providers table `name`.
COLLECTORS: Dict[str, Type[BaseCollector]] = {
    "anthropic": AnthropicCollector,
    "claude-ai": ClaudeAIAnalyticsCollector,
    "openai": OpenAICollector,
    "cursor": CursorCollector,
    "vercel": VercelCollector,
}

# provider name -> {kwarg: ENV_VAR}. "api_key" is required; others are optional
# scoping fields forwarded to the collector's __init__ when present.
PROVIDER_ENV: Dict[str, Dict[str, str]] = {
    "anthropic": {"api_key": "ANTHROPIC_ADMIN_KEY", "organization_id": "ANTHROPIC_ORG_ID"},
    "claude-ai": {"api_key": "CLAUDE_AI_ANALYTICS_KEY", "organization_id": "CLAUDE_AI_ORG_ID"},
    "openai": {"api_key": "OPENAI_ADMIN_KEY", "organization_id": "OPENAI_ORG_ID"},
    "cursor": {"api_key": "CURSOR_ADMIN_KEY", "team_id": "CURSOR_TEAM_ID"},
    "vercel": {"api_key": "VERCEL_TOKEN", "team_id": "VERCEL_TEAM_ID"},
}

_owner_user_id_cache: Optional[str] = None


def get_owner_user_id() -> str:
    """
    Resolve the single owner user id that all collected records are attributed
    to. Prefers DASHBOARD_OWNER_USER_ID; otherwise looks up DASHBOARD_OWNER_EMAIL
    (default ``robert@liatrio.com``) against Supabase auth. Result is cached.
    """
    global _owner_user_id_cache
    if _owner_user_id_cache:
        return _owner_user_id_cache

    explicit = os.environ.get("DASHBOARD_OWNER_USER_ID")
    if explicit:
        _owner_user_id_cache = explicit
        return explicit

    email = os.environ.get("DASHBOARD_OWNER_EMAIL", DEFAULT_OWNER_EMAIL)
    supabase = get_supabase_client()
    response = supabase.auth.admin.list_users()
    # supabase-py may return a list or an object with `.users`
    users = response if isinstance(response, list) else getattr(response, "users", []) or []
    for user in users:
        if getattr(user, "email", None) == email:
            _owner_user_id_cache = user.id
            logger.info(f"Resolved dashboard owner '{email}' -> {user.id}")
            return user.id

    raise RuntimeError(
        f"Could not resolve owner user id for '{email}'. Set DASHBOARD_OWNER_USER_ID "
        f"to the auth.users UUID, or ensure that user exists."
    )


def _provider_env(provider_name: str) -> tuple[Optional[str], Dict[str, Any]]:
    """Read the provider's api key + optional scoping metadata from env."""
    cfg = PROVIDER_ENV.get(provider_name, {})
    api_key = os.environ.get(cfg["api_key"]) if "api_key" in cfg else None
    metadata: Dict[str, Any] = {}
    for field, env_var in cfg.items():
        if field == "api_key":
            continue
        value = os.environ.get(env_var)
        if value:
            metadata[field] = value
    return api_key, metadata


def _build_collector(
    collector_cls: Type[BaseCollector],
    api_key: str,
    user_id: str,
    provider_id: str,
    metadata: Optional[Dict[str, Any]] = None,
):
    """
    Construct a collector, forwarding any scoping fields (organization_id,
    team_id) the collector's __init__ accepts.
    """
    accepted = set(inspect.signature(collector_cls.__init__).parameters)
    reserved = {"self", "api_key", "user_id", "provider_id"}
    extra = {
        key: value
        for key, value in (metadata or {}).items()
        if key in accepted and key not in reserved
    }
    return collector_cls(
        api_key=api_key,
        user_id=user_id,
        provider_id=provider_id,
        **extra,
    )


async def run_collection_for_provider(
    provider_name: str,
    backfill: bool = False,
    backfill_days: int = 90,
) -> Dict[str, Any]:
    """
    Collect a single provider using its env-configured org key, attributing all
    records to the owner user. Returns a summary dict; never raises for
    operational errors (so a cron call always gets a structured response).
    """
    timestamp = datetime.utcnow().isoformat()
    collector_cls = COLLECTORS.get(provider_name)
    if collector_cls is None:
        return {
            "status": "error",
            "provider": provider_name,
            "error": f"Unsupported provider. Supported: {', '.join(COLLECTORS)}",
            "timestamp": timestamp,
        }

    api_key, metadata = _provider_env(provider_name)
    if not api_key:
        env_var = PROVIDER_ENV[provider_name]["api_key"]
        logger.warning(f"Skipping {provider_name}: {env_var} is not set")
        return {
            "status": "skipped",
            "provider": provider_name,
            "reason": f"{env_var} is not configured",
            "records_stored": 0,
            "timestamp": timestamp,
        }

    try:
        supabase = get_supabase_client()
        provider_response = (
            supabase.from_("providers").select("id").eq("name", provider_name).single().execute()
        )
        if not provider_response.data:
            return {
                "status": "error",
                "provider": provider_name,
                "error": f"Provider '{provider_name}' not found in providers table",
                "timestamp": timestamp,
            }
        provider_id = provider_response.data["id"]
        owner_user_id = get_owner_user_id()

        async with _build_collector(
            collector_cls, api_key, owner_user_id, provider_id, metadata
        ) as collector:
            if backfill:
                result = await collector.backfill_historical_data(days=backfill_days)
            else:
                result = await collector.run()

        return {
            "status": result.get("status", "unknown"),
            "provider": provider_name,
            "records_collected": result.get("records_collected", 0),
            "records_stored": result.get("records_stored", 0),
            "owner_user_id": owner_user_id,
            "timestamp": result.get("timestamp", timestamp),
            "error": result.get("error"),
        }

    except Exception as e:  # noqa: BLE001 - surface as a structured result
        logger.error(f"{provider_name} collection failed: {str(e)}")
        return {
            "status": "error",
            "provider": provider_name,
            "error": str(e),
            "timestamp": timestamp,
        }
