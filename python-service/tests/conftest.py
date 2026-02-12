"""
Shared pytest fixtures for testing
"""
import pytest
from datetime import datetime, timedelta
from unittest.mock import Mock, AsyncMock


@pytest.fixture
def mock_supabase_client():
    """Mock Supabase client for testing"""
    client = Mock()
    client.table = Mock(return_value=Mock())
    client.table.return_value.insert = AsyncMock(return_value=Mock(data=[], error=None))
    client.table.return_value.select = Mock(return_value=Mock())
    client.table.return_value.select.return_value.execute = AsyncMock(
        return_value=Mock(data=[], error=None)
    )
    return client


@pytest.fixture
def sample_cost_data():
    """Sample cost data for testing"""
    return [
        {
            "user_id": "test-user-123",
            "provider_id": "openai",
            "timestamp": datetime.now().isoformat(),
            "model_name": "gpt-4",
            "cost_usd": 0.06,
            "tokens_used": 2000,
            "input_tokens": 1500,
            "output_tokens": 500,
            "request_count": 1,
            "collection_method": "api",
            "metadata": {},
        }
    ]


@pytest.fixture
def sample_api_response():
    """Sample API response from OpenAI/Anthropic"""
    return {
        "id": "chatcmpl-123",
        "object": "chat.completion",
        "created": 1677652288,
        "model": "gpt-4",
        "usage": {
            "prompt_tokens": 1500,
            "completion_tokens": 500,
            "total_tokens": 2000,
        },
        "choices": [
            {
                "message": {"role": "assistant", "content": "Test response"},
                "finish_reason": "stop",
                "index": 0,
            }
        ],
    }


@pytest.fixture
def forecast_training_data():
    """Generate synthetic training data for forecasting tests"""
    data = []
    base_date = datetime.now() - timedelta(days=90)
    for i in range(90):
        date = base_date + timedelta(days=i)
        # Simple trend + noise
        cost = 50 + i * 0.5 + (i % 7) * 5  # Weekly pattern
        data.append({"date": date.isoformat(), "cost_usd": cost})
    return data


@pytest.fixture
def mock_openai_client():
    """Mock OpenAI API client"""
    client = Mock()
    client.chat = Mock()
    client.chat.completions = Mock()
    client.chat.completions.list = AsyncMock(
        return_value=Mock(
            data=[
                Mock(
                    usage=Mock(prompt_tokens=100, completion_tokens=50, total_tokens=150),
                    created_at=datetime.now().timestamp(),
                )
            ]
        )
    )
    return client


@pytest.fixture
def mock_anthropic_client():
    """Mock Anthropic API client"""
    client = Mock()
    client.messages = Mock()
    client.messages.list = AsyncMock(
        return_value=[
            Mock(
                usage=Mock(input_tokens=100, output_tokens=50),
                created_at=datetime.now().isoformat(),
            )
        ]
    )
    return client
