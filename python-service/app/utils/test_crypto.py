"""
Unit tests for crypto.py module.

Run with: pytest app/utils/test_crypto.py -v

These tests verify:
- Encryption/decryption correctness
- Key masking
- Error handling
- Security properties (no key leakage in logs)
"""

import os
import pytest
from unittest.mock import patch, MagicMock
from uuid import uuid4

# Set test encryption key before importing crypto module
os.environ["ENCRYPTION_KEY"] = "test-key-" + "a" * 54 + "="  # Valid Fernet key
os.environ["ENCRYPTION_KEY_ID"] = "test-v1"

from app.utils.crypto import (
    encrypt_api_key,
    decrypt_api_key,
    mask_api_key,
    EncryptionError,
    DecryptionError,
    get_encryption_key,
    generate_new_encryption_key,
    store_encrypted_key,
    retrieve_decrypted_key,
    KeyNotFoundError,
)


class TestEncryptionDecryption:
    """Test core encryption and decryption functions."""

    def test_encrypt_api_key_success(self):
        """Test successful encryption of API key."""
        plaintext = "sk-ant-api03-test123456789"
        encrypted = encrypt_api_key(plaintext)

        assert encrypted is not None
        assert isinstance(encrypted, str)
        assert encrypted != plaintext  # Encrypted value differs
        assert len(encrypted) > len(plaintext)  # Encrypted is longer

    def test_decrypt_api_key_success(self):
        """Test successful decryption of API key."""
        plaintext = "sk-ant-api03-test123456789"
        encrypted = encrypt_api_key(plaintext)
        decrypted = decrypt_api_key(encrypted)

        assert decrypted == plaintext  # Round-trip successful

    def test_encrypt_empty_string_fails(self):
        """Test that encrypting empty string raises error."""
        with pytest.raises(EncryptionError):
            encrypt_api_key("")

    def test_encrypt_none_fails(self):
        """Test that encrypting None raises error."""
        with pytest.raises(EncryptionError):
            encrypt_api_key(None)

    def test_decrypt_invalid_token_fails(self):
        """Test that decrypting invalid token raises error."""
        with pytest.raises(DecryptionError):
            decrypt_api_key("invalid-encrypted-string")

    def test_decrypt_empty_string_fails(self):
        """Test that decrypting empty string raises error."""
        with pytest.raises(DecryptionError):
            decrypt_api_key("")

    def test_encryption_is_non_deterministic(self):
        """Test that encrypting same plaintext produces different ciphertexts (due to IV)."""
        plaintext = "sk-ant-api03-test123456789"
        encrypted1 = encrypt_api_key(plaintext)
        encrypted2 = encrypt_api_key(plaintext)

        # Different ciphertexts (due to random IV in Fernet)
        assert encrypted1 != encrypted2

        # But both decrypt to same plaintext
        assert decrypt_api_key(encrypted1) == plaintext
        assert decrypt_api_key(encrypted2) == plaintext


class TestKeyMasking:
    """Test API key masking for UI display."""

    def test_mask_anthropic_key(self):
        """Test masking Anthropic API key format."""
        key = "sk-ant-api03-abcdefghijklmnop1234567890"
        masked = mask_api_key(key)

        assert masked.startswith("sk-ant-")
        assert masked.endswith("7890")
        assert "..." in masked
        assert "abcdefg" not in masked  # Middle part hidden

    def test_mask_openai_key(self):
        """Test masking OpenAI API key format."""
        key = "sk-proj-abcdefghijklmnop1234567890"
        masked = mask_api_key(key)

        assert masked.startswith("sk-proj-")
        assert masked.endswith("7890")
        assert "..." in masked

    def test_mask_short_key(self):
        """Test masking very short key."""
        key = "abc"
        masked = mask_api_key(key)

        assert masked == "***"  # Too short to mask

    def test_mask_empty_key(self):
        """Test masking empty key."""
        masked = mask_api_key("")
        assert masked == "***"

    def test_mask_custom_visible_chars(self):
        """Test masking with custom number of visible characters."""
        key = "sk-ant-api03-abcdefghijklmnop1234567890"
        masked = mask_api_key(key, visible_chars=8)

        assert masked.endswith("34567890")  # Last 8 chars visible


class TestKeyGeneration:
    """Test encryption key generation."""

    def test_generate_new_encryption_key(self):
        """Test generating a new encryption key."""
        key = generate_new_encryption_key()

        assert key is not None
        assert isinstance(key, str)
        assert len(key) > 40  # Fernet keys are base64-encoded 32 bytes

    def test_generated_key_is_valid(self):
        """Test that generated key is valid for encryption."""
        new_key = generate_new_encryption_key()

        # Temporarily use new key
        original_key = os.environ.get("ENCRYPTION_KEY")
        os.environ["ENCRYPTION_KEY"] = new_key

        try:
            # Test encryption/decryption with new key
            plaintext = "test-key-123"
            encrypted = encrypt_api_key(plaintext)
            decrypted = decrypt_api_key(encrypted)
            assert decrypted == plaintext
        finally:
            # Restore original key
            os.environ["ENCRYPTION_KEY"] = original_key


class TestEnvironmentVariables:
    """Test environment variable handling."""

    def test_get_encryption_key_success(self):
        """Test retrieving encryption key from environment."""
        key = get_encryption_key()
        assert key is not None
        assert isinstance(key, bytes)

    @patch.dict(os.environ, {"ENCRYPTION_KEY": ""}, clear=False)
    def test_missing_encryption_key_raises_error(self):
        """Test that missing ENCRYPTION_KEY raises error."""
        # Clear the lru_cache for get_encryption_key
        import app.utils.crypto as crypto_module
        if hasattr(crypto_module.get_encryption_key, "cache_clear"):
            crypto_module.get_encryption_key.cache_clear()

        with pytest.raises(ValueError, match="ENCRYPTION_KEY environment variable"):
            get_encryption_key()


class TestDatabaseOperations:
    """Test database operations with mocked Supabase client."""

    @patch("app.utils.crypto.get_supabase_client")
    def test_store_encrypted_key_success(self, mock_get_client):
        """Test storing encrypted key in database."""
        # Mock Supabase client
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.data = [
            {
                "id": str(uuid4()),
                "user_id": str(uuid4()),
                "provider_id": str(uuid4()),
                "credential_name": "Test Key",
                "encrypted_api_key": "encrypted-value",
                "is_active": True,
            }
        ]

        mock_client.from_.return_value.insert.return_value.execute.return_value = (
            mock_response
        )
        mock_get_client.return_value = mock_client

        # Store key
        user_id = uuid4()
        provider_id = uuid4()
        result = store_encrypted_key(
            user_id=user_id,
            provider_id=provider_id,
            credential_name="Test Key",
            plaintext_api_key="sk-ant-test123",
        )

        # Verify
        assert result is not None
        assert "encrypted_api_key" in result
        assert result["encrypted_api_key"] == "***encrypted***"  # Masked

    @patch("app.utils.crypto.get_supabase_client")
    def test_retrieve_decrypted_key_success(self, mock_get_client):
        """Test retrieving and decrypting key from database."""
        # Encrypt a test key
        plaintext = "sk-ant-test123"
        encrypted = encrypt_api_key(plaintext)

        # Mock Supabase client
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.data = [
            {
                "id": str(uuid4()),
                "user_id": str(uuid4()),
                "provider_id": str(uuid4()),
                "credential_name": "Test Key",
                "encrypted_api_key": encrypted,
                "is_active": True,
                "metadata": {"test": "value"},
            }
        ]

        mock_client.from_.return_value.select.return_value.eq.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = mock_response
        mock_get_client.return_value = mock_client

        # Retrieve key
        user_id = uuid4()
        provider_id = uuid4()
        decrypted_key, metadata = retrieve_decrypted_key(
            user_id=user_id, provider_id=provider_id
        )

        # Verify
        assert decrypted_key == plaintext
        assert metadata["test"] == "value"

    @patch("app.utils.crypto.get_supabase_client")
    def test_retrieve_key_not_found(self, mock_get_client):
        """Test retrieving non-existent key raises error."""
        # Mock empty response
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.data = []

        mock_client.from_.return_value.select.return_value.eq.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = mock_response
        mock_get_client.return_value = mock_client

        # Attempt to retrieve
        user_id = uuid4()
        provider_id = uuid4()

        with pytest.raises(KeyNotFoundError):
            retrieve_decrypted_key(user_id=user_id, provider_id=provider_id)


class TestSecurityProperties:
    """Test security properties and guarantees."""

    def test_plaintext_key_not_in_encrypted_value(self):
        """Test that plaintext key doesn't appear in encrypted value."""
        plaintext = "sk-ant-api03-very-secret-key-12345"
        encrypted = encrypt_api_key(plaintext)

        assert plaintext not in encrypted
        assert "very-secret" not in encrypted

    def test_encrypted_values_are_different_each_time(self):
        """Test that encryption produces different outputs (security property)."""
        plaintext = "sk-ant-test123"

        encrypted_values = [encrypt_api_key(plaintext) for _ in range(5)]

        # All values should be unique (due to random IV)
        assert len(set(encrypted_values)) == len(encrypted_values)

    @patch("app.utils.crypto.logger")
    def test_no_plaintext_in_logs(self, mock_logger):
        """Test that plaintext keys never appear in log messages."""
        plaintext = "sk-ant-api03-secret123"

        # Encrypt and decrypt
        encrypted = encrypt_api_key(plaintext)
        decrypted = decrypt_api_key(encrypted)

        # Check all log calls
        for call in mock_logger.info.call_args_list:
            log_message = str(call)
            assert plaintext not in log_message
            assert "secret123" not in log_message

    def test_mask_hides_sensitive_parts(self):
        """Test that masking hides the sensitive middle part of key."""
        key = "sk-ant-api03-THIS-IS-SECRET-DATA-1234"
        masked = mask_api_key(key)

        assert "THIS-IS-SECRET-DATA" not in masked
        assert masked.startswith("sk-ant-")
        assert masked.endswith("1234")


class TestErrorHandling:
    """Test error handling and edge cases."""

    def test_decrypt_with_wrong_key_fails(self):
        """Test that decrypting with wrong key fails gracefully."""
        plaintext = "sk-ant-test123"
        encrypted = encrypt_api_key(plaintext)

        # Change encryption key
        original_key = os.environ["ENCRYPTION_KEY"]
        os.environ["ENCRYPTION_KEY"] = generate_new_encryption_key()

        try:
            with pytest.raises(DecryptionError):
                decrypt_api_key(encrypted)
        finally:
            # Restore original key
            os.environ["ENCRYPTION_KEY"] = original_key

    def test_encrypt_non_string_fails(self):
        """Test that encrypting non-string fails."""
        with pytest.raises(EncryptionError):
            encrypt_api_key(12345)

        with pytest.raises(EncryptionError):
            encrypt_api_key(["key"])


# ============================================================================
# Integration Tests (require database connection)
# ============================================================================


@pytest.mark.integration
@pytest.mark.skip(reason="Requires live database connection")
class TestIntegration:
    """Integration tests with real database (skip by default)."""

    def test_full_encryption_flow(self):
        """Test complete encryption flow from storage to retrieval."""
        user_id = uuid4()
        provider_id = uuid4()
        plaintext = "sk-ant-integration-test-key"

        # Store
        credential = store_encrypted_key(
            user_id=user_id,
            provider_id=provider_id,
            credential_name="Integration Test",
            plaintext_api_key=plaintext,
        )

        credential_id = credential["id"]

        # Retrieve
        decrypted, metadata = retrieve_decrypted_key(
            user_id=user_id, provider_id=provider_id
        )

        assert decrypted == plaintext

        # Clean up
        from app.utils.crypto import delete_api_key_permanently

        delete_api_key_permanently(
            user_id=user_id,
            credential_id=credential_id,
            confirmation_token="CONFIRM_DELETE",
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
