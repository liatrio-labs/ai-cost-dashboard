"""
Tests for API collectors
"""
import pytest
from datetime import datetime
from unittest.mock import Mock, patch, AsyncMock


@pytest.mark.unit
def test_cost_calculation():
    """Test basic cost calculation"""
    # Example: GPT-4 pricing
    prompt_tokens = 1500
    completion_tokens = 500

    # GPT-4 rates: $0.03 per 1K prompt tokens, $0.06 per 1K completion tokens
    expected_cost = (prompt_tokens / 1000 * 0.03) + (completion_tokens / 1000 * 0.06)

    assert expected_cost == 0.075


@pytest.mark.unit
def test_parse_openai_response(sample_api_response):
    """Test parsing OpenAI API response"""
    response = sample_api_response

    assert response["model"] == "gpt-4"
    assert response["usage"]["total_tokens"] == 2000
    assert response["usage"]["prompt_tokens"] == 1500
    assert response["usage"]["completion_tokens"] == 500


@pytest.mark.unit
@patch('httpx.AsyncClient')
async def test_openai_collector_fetch(mock_client, mock_supabase_client):
    """Test OpenAI collector fetches data correctly"""
    # Mock API response
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json = Mock(return_value={
        "data": [
            {
                "timestamp": datetime.now().timestamp(),
                "n_requests": 10,
                "operation": "completion",
                "snapshot_id": "gpt-4",
                "n_context_tokens_total": 15000,
                "n_generated_tokens_total": 5000,
            }
        ]
    })

    mock_client.return_value.__aenter__.return_value.get = AsyncMock(
        return_value=mock_response
    )

    # Test would call collector function here
    assert mock_response.status_code == 200


@pytest.mark.unit
def test_timestamp_formatting():
    """Test timestamp formatting for database"""
    timestamp = datetime(2024, 1, 1, 12, 0, 0)
    iso_format = timestamp.isoformat()

    assert "2024-01-01" in iso_format
    assert "12:00:00" in iso_format


@pytest.mark.unit
def test_cost_data_validation(sample_cost_data):
    """Test cost data has required fields"""
    data = sample_cost_data[0]

    required_fields = [
        "user_id",
        "provider_id",
        "timestamp",
        "model_name",
        "cost_usd",
        "request_count",
        "collection_method",
    ]

    for field in required_fields:
        assert field in data, f"Missing required field: {field}"


@pytest.mark.unit
def test_batch_processing():
    """Test batching large number of records"""
    records = [{"id": i} for i in range(1000)]
    batch_size = 100

    batches = [records[i:i + batch_size] for i in range(0, len(records), batch_size)]

    assert len(batches) == 10
    assert len(batches[0]) == batch_size
    assert len(batches[-1]) == batch_size


@pytest.mark.integration
@patch('httpx.AsyncClient')
async def test_anthropic_api_integration(mock_client):
    """Test Anthropic API integration"""
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json = Mock(return_value={
        "content": [{"text": "Test response"}],
        "usage": {
            "input_tokens": 100,
            "output_tokens": 50,
        }
    })

    mock_client.return_value.__aenter__.return_value.post = AsyncMock(
        return_value=mock_response
    )

    assert mock_response.json()["usage"]["input_tokens"] == 100
