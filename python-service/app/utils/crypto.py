"""
API Key Encryption and Security Utilities

This module provides secure encryption/decryption of API keys using AES-256 (Fernet).
Keys are encrypted before storage in the database and decrypted only when needed.

CRITICAL SECURITY REQUIREMENTS:
- API keys MUST NEVER appear in logs, responses, or error messages
- Decryption happens only at point of use (API calls)
- All key access is audited in the database
- Keys are masked in UI/responses (show only last 4 characters)

Key Management Best Practices:
1. Store ENCRYPTION_KEY in environment variable (never in code)
2. Use 32-byte base64-encoded key (generate with: Fernet.generate_key())
3. Rotate encryption keys periodically (use encryption_key_id)
4. Never log plaintext API keys
5. Use secure deletion when revoking keys
"""

import os
import logging
from typing import Optional, Dict, Any, Tuple
from datetime import datetime
from uuid import UUID
import base64

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2
from supabase import Client

from .supabase_client import get_supabase_client

# Configure logger - CRITICAL: Never log plaintext API keys
logger = logging.getLogger(__name__)


class CryptoError(Exception):
    """Base exception for cryptography operations."""
    pass


class EncryptionError(CryptoError):
    """Raised when encryption fails."""
    pass


class DecryptionError(CryptoError):
    """Raised when decryption fails."""
    pass


class KeyNotFoundError(CryptoError):
    """Raised when API credential not found in database."""
    pass


# ============================================================================
# ENCRYPTION KEY MANAGEMENT
# ============================================================================

def get_encryption_key() -> bytes:
    """
    Get the encryption key from environment variable.

    Returns:
        bytes: Fernet encryption key

    Raises:
        ValueError: If ENCRYPTION_KEY is not set or invalid
    """
    key_string = os.getenv("ENCRYPTION_KEY")

    if not key_string:
        raise ValueError(
            "ENCRYPTION_KEY environment variable is not set. "
            "Generate one with: python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'"
        )

    try:
        # Validate it's a valid Fernet key (32 url-safe base64-encoded bytes)
        key_bytes = key_string.encode() if isinstance(key_string, str) else key_string
        Fernet(key_bytes)  # This will raise if invalid
        return key_bytes
    except Exception as e:
        raise ValueError(f"Invalid ENCRYPTION_KEY format: {e}")


def get_current_key_id() -> str:
    """
    Get the current encryption key version ID.

    This allows for key rotation - when rotating keys, increment the version.

    Returns:
        str: Current key version ID (e.g., 'v1', 'v2')
    """
    return os.getenv("ENCRYPTION_KEY_ID", "v1")


def generate_new_encryption_key() -> str:
    """
    Generate a new Fernet encryption key.

    Use this to create a new ENCRYPTION_KEY for your environment.

    Returns:
        str: Base64-encoded encryption key (store in ENCRYPTION_KEY env var)
    """
    return Fernet.generate_key().decode()


# ============================================================================
# CORE ENCRYPTION/DECRYPTION
# ============================================================================

def encrypt_api_key(plaintext_key: str) -> str:
    """
    Encrypt an API key using AES-256 (Fernet).

    Args:
        plaintext_key: The plaintext API key to encrypt

    Returns:
        str: Base64-encoded encrypted key

    Raises:
        EncryptionError: If encryption fails

    Security Notes:
        - plaintext_key is NOT logged
        - Returns opaque encrypted string safe for database storage
    """
    if not plaintext_key or not isinstance(plaintext_key, str):
        raise EncryptionError("API key must be a non-empty string")

    try:
        fernet = Fernet(get_encryption_key())
        encrypted_bytes = fernet.encrypt(plaintext_key.encode())
        encrypted_string = encrypted_bytes.decode()

        # Log success WITHOUT logging the key
        logger.info("API key encrypted successfully")
        return encrypted_string

    except Exception as e:
        logger.error(f"Encryption failed: {type(e).__name__}")
        raise EncryptionError(f"Failed to encrypt API key: {type(e).__name__}")


def decrypt_api_key(encrypted_key: str) -> str:
    """
    Decrypt an API key from database.

    Args:
        encrypted_key: Base64-encoded encrypted key from database

    Returns:
        str: Plaintext API key (USE CAREFULLY - never log or expose)

    Raises:
        DecryptionError: If decryption fails (invalid key, wrong encryption key, corrupted data)

    Security Notes:
        - Return value is plaintext API key - handle with extreme care
        - NEVER log the return value
        - Use only at point of API call
    """
    if not encrypted_key or not isinstance(encrypted_key, str):
        raise DecryptionError("Encrypted key must be a non-empty string")

    try:
        fernet = Fernet(get_encryption_key())
        decrypted_bytes = fernet.decrypt(encrypted_key.encode())
        plaintext_key = decrypted_bytes.decode()

        # Log success WITHOUT logging the key
        logger.info("API key decrypted successfully")
        return plaintext_key

    except InvalidToken:
        logger.error("Decryption failed: Invalid token or wrong encryption key")
        raise DecryptionError("Failed to decrypt API key: invalid token or wrong encryption key")
    except Exception as e:
        logger.error(f"Decryption failed: {type(e).__name__}")
        raise DecryptionError(f"Failed to decrypt API key: {type(e).__name__}")


def mask_api_key(api_key: str, visible_chars: int = 4) -> str:
    """
    Mask an API key for display purposes (show only last N characters).

    Args:
        api_key: The API key to mask
        visible_chars: Number of characters to show at the end (default: 4)

    Returns:
        str: Masked key (e.g., "sk-...abc123" or "***...xyz9")

    Example:
        >>> mask_api_key("sk-ant-api03-abcdefghijklmnop123456")
        "sk-ant...3456"
    """
    if not api_key or len(api_key) <= visible_chars:
        return "***"

    # Extract prefix if present (e.g., "sk-", "sk-ant-", "sk-proj-")
    prefix = ""
    if api_key.startswith("sk-"):
        parts = api_key.split("-")
        if len(parts) >= 2:
            prefix = "-".join(parts[:2]) + "-"  # e.g., "sk-ant-"

    last_chars = api_key[-visible_chars:]
    return f"{prefix}...{last_chars}"


# ============================================================================
# DATABASE OPERATIONS
# ============================================================================

def store_encrypted_key(
    user_id: UUID,
    provider_id: UUID,
    credential_name: str,
    plaintext_api_key: str,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Encrypt and store an API key in the database.

    Args:
        user_id: UUID of the user
        provider_id: UUID of the provider
        credential_name: User-defined name for the credential
        plaintext_api_key: The plaintext API key to encrypt and store
        metadata: Optional additional metadata (e.g., organization_id)

    Returns:
        dict: Created credential record (with masked key)

    Raises:
        EncryptionError: If encryption fails
        Exception: If database operation fails

    Security:
        - API key is encrypted before database insertion
        - Audit log entry created automatically
    """
    try:
        # Encrypt the API key
        encrypted_key = encrypt_api_key(plaintext_api_key)
        key_id = get_current_key_id()

        # Prepare record
        record = {
            "user_id": str(user_id),
            "provider_id": str(provider_id),
            "credential_name": credential_name,
            "encrypted_api_key": encrypted_key,
            "encryption_key_id": key_id,
            "is_active": True,
            "validation_status": "pending",
            "metadata": metadata or {}
        }

        # Insert into database
        client = get_supabase_client()
        response = client.from_("api_credentials").insert(record).execute()

        if not response.data:
            raise Exception("Failed to store encrypted key: no data returned")

        created_record = response.data[0]

        # Log success with audit trail (NO plaintext key)
        logger.info(
            f"Stored encrypted API key for user {user_id}, provider {provider_id}, "
            f"credential '{credential_name}'"
        )

        # Create audit log entry
        _create_audit_log(
            user_id=user_id,
            credential_id=UUID(created_record["id"]),
            action="key_created",
            details={"credential_name": credential_name, "provider_id": str(provider_id)}
        )

        # Return record with masked key
        return _mask_credential_response(created_record)

    except EncryptionError:
        raise
    except Exception as e:
        logger.error(f"Failed to store encrypted key: {type(e).__name__}: {str(e)}")
        raise


def retrieve_decrypted_key(
    user_id: UUID,
    provider_id: UUID,
    credential_name: Optional[str] = None
) -> Tuple[str, Dict[str, Any]]:
    """
    Retrieve and decrypt an API key from the database.

    Args:
        user_id: UUID of the user
        provider_id: UUID of the provider
        credential_name: Optional specific credential name (returns first active if None)

    Returns:
        tuple: (plaintext_api_key, credential_metadata)

    Raises:
        KeyNotFoundError: If no matching credential found
        DecryptionError: If decryption fails

    Security:
        - Returns plaintext key - USE IMMEDIATELY and don't store
        - Audit log entry created
        - NEVER log the returned key
    """
    try:
        client = get_supabase_client()

        # Build query
        query = client.from_("api_credentials").select("*").eq("user_id", str(user_id)).eq("provider_id", str(provider_id)).eq("is_active", True)

        if credential_name:
            query = query.eq("credential_name", credential_name)

        response = query.limit(1).execute()

        if not response.data:
            raise KeyNotFoundError(
                f"No active API credential found for user {user_id}, provider {provider_id}"
                + (f", credential '{credential_name}'" if credential_name else "")
            )

        credential = response.data[0]
        credential_id = UUID(credential["id"])
        encrypted_key = credential["encrypted_api_key"]

        # Decrypt the key
        plaintext_key = decrypt_api_key(encrypted_key)

        # Create audit log entry
        _create_audit_log(
            user_id=user_id,
            credential_id=credential_id,
            action="key_accessed",
            details={"credential_name": credential["credential_name"]}
        )

        logger.info(
            f"Retrieved and decrypted API key for user {user_id}, "
            f"credential {credential_id}"
        )

        return plaintext_key, credential.get("metadata", {})

    except (KeyNotFoundError, DecryptionError):
        raise
    except Exception as e:
        logger.error(f"Failed to retrieve key: {type(e).__name__}: {str(e)}")
        raise


def update_credential_validation_status(
    credential_id: UUID,
    status: str,
    error_message: Optional[str] = None
) -> None:
    """
    Update the validation status of an API credential.

    Args:
        credential_id: UUID of the credential
        status: Validation status ('valid', 'invalid', 'pending', 'error')
        error_message: Optional error message if validation failed
    """
    try:
        client = get_supabase_client()

        update_data = {
            "validation_status": status,
            "last_validated_at": datetime.utcnow().isoformat()
        }

        if error_message and status in ("invalid", "error"):
            metadata = {"last_error": error_message}
            update_data["metadata"] = metadata

        client.from_("api_credentials").update(update_data).eq("id", str(credential_id)).execute()

        logger.info(f"Updated credential {credential_id} validation status to '{status}'")

    except Exception as e:
        logger.error(f"Failed to update validation status: {e}")


def revoke_api_key(
    user_id: UUID,
    credential_id: UUID,
    reason: str = "user_requested"
) -> None:
    """
    Revoke (deactivate) an API key.

    Args:
        user_id: UUID of the user (for verification)
        credential_id: UUID of the credential to revoke
        reason: Reason for revocation (for audit trail)

    Raises:
        KeyNotFoundError: If credential not found or not owned by user

    Security:
        - Does not delete the encrypted key (for audit trail)
        - Sets is_active = false
        - Creates audit log entry
    """
    try:
        client = get_supabase_client()

        # Verify credential belongs to user
        response = client.from_("api_credentials").select("id, credential_name").eq("id", str(credential_id)).eq("user_id", str(user_id)).execute()

        if not response.data:
            raise KeyNotFoundError(
                f"Credential {credential_id} not found or not owned by user {user_id}"
            )

        credential_name = response.data[0]["credential_name"]

        # Deactivate the credential
        client.from_("api_credentials").update({"is_active": False}).eq("id", str(credential_id)).execute()

        # Create audit log entry
        _create_audit_log(
            user_id=user_id,
            credential_id=credential_id,
            action="key_revoked",
            details={"reason": reason, "credential_name": credential_name}
        )

        logger.warning(
            f"Revoked API credential {credential_id} for user {user_id}. "
            f"Reason: {reason}"
        )

    except KeyNotFoundError:
        raise
    except Exception as e:
        logger.error(f"Failed to revoke key: {e}")
        raise


def delete_api_key_permanently(
    user_id: UUID,
    credential_id: UUID,
    confirmation_token: str
) -> None:
    """
    Permanently delete an API key from the database (secure deletion).

    DANGEROUS: This cannot be undone. Use revoke_api_key() instead for normal deactivation.

    Args:
        user_id: UUID of the user
        credential_id: UUID of the credential to delete
        confirmation_token: Must be "CONFIRM_DELETE" to proceed

    Raises:
        ValueError: If confirmation token is incorrect
        KeyNotFoundError: If credential not found
    """
    if confirmation_token != "CONFIRM_DELETE":
        raise ValueError("Invalid confirmation token. Deletion aborted.")

    try:
        client = get_supabase_client()

        # Verify ownership
        response = client.from_("api_credentials").select("id, credential_name").eq("id", str(credential_id)).eq("user_id", str(user_id)).execute()

        if not response.data:
            raise KeyNotFoundError(f"Credential {credential_id} not found")

        credential_name = response.data[0]["credential_name"]

        # Create audit log BEFORE deletion
        _create_audit_log(
            user_id=user_id,
            credential_id=credential_id,
            action="key_deleted_permanently",
            details={"credential_name": credential_name}
        )

        # Permanently delete
        client.from_("api_credentials").delete().eq("id", str(credential_id)).execute()

        logger.warning(
            f"PERMANENTLY DELETED credential {credential_id} for user {user_id}"
        )

    except KeyNotFoundError:
        raise
    except Exception as e:
        logger.error(f"Failed to delete key: {e}")
        raise


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _mask_credential_response(credential: Dict[str, Any]) -> Dict[str, Any]:
    """
    Mask the encrypted API key in a credential response.

    Args:
        credential: Credential record from database

    Returns:
        dict: Credential with encrypted_api_key replaced by masked version
    """
    masked = credential.copy()
    if "encrypted_api_key" in masked:
        # Show only that key exists, not the encrypted value
        masked["encrypted_api_key"] = "***encrypted***"
    return masked


def _create_audit_log(
    user_id: UUID,
    credential_id: UUID,
    action: str,
    details: Optional[Dict[str, Any]] = None
) -> None:
    """
    Create an audit log entry for API key access/operations.

    Args:
        user_id: UUID of the user
        credential_id: UUID of the credential
        action: Action performed (key_created, key_accessed, key_revoked, etc.)
        details: Optional additional details

    Note:
        This creates entries in a separate audit log table (to be created in future migration).
        For now, logs to application logger.
    """
    # TODO: Store in database audit_log table (future migration)
    # For now, log to application logs
    logger.info(
        f"AUDIT: user={user_id}, credential={credential_id}, "
        f"action={action}, details={details}"
    )


def list_user_credentials(
    user_id: UUID,
    include_inactive: bool = False
) -> list[Dict[str, Any]]:
    """
    List all API credentials for a user (with masked keys).

    Args:
        user_id: UUID of the user
        include_inactive: If True, include revoked credentials

    Returns:
        list: List of credential records with masked keys
    """
    try:
        client = get_supabase_client()

        query = client.from_("api_credentials").select("*, providers(name, display_name)").eq("user_id", str(user_id))

        if not include_inactive:
            query = query.eq("is_active", True)

        response = query.order("created_at", desc=True).execute()

        # Mask all credentials
        masked_credentials = [_mask_credential_response(cred) for cred in response.data]

        return masked_credentials

    except Exception as e:
        logger.error(f"Failed to list credentials: {e}")
        raise


# ============================================================================
# KEY ROTATION (Future Enhancement)
# ============================================================================

def rotate_encryption_key(
    old_key: bytes,
    new_key: bytes,
    new_key_id: str,
    batch_size: int = 100
) -> int:
    """
    Rotate encryption keys for all stored API credentials.

    This re-encrypts all API keys with a new encryption key.
    Use when ENCRYPTION_KEY needs to be changed.

    Args:
        old_key: Current encryption key (from old ENCRYPTION_KEY)
        new_key: New encryption key (new ENCRYPTION_KEY value)
        new_key_id: New key version ID (e.g., 'v2')
        batch_size: Number of credentials to process per batch

    Returns:
        int: Number of credentials re-encrypted

    WARNING: This is a sensitive operation. Test thoroughly before production use.
    """
    # TODO: Implement key rotation
    # 1. Fetch all credentials with old encryption_key_id
    # 2. For each credential:
    #    a. Decrypt with old_key
    #    b. Encrypt with new_key
    #    c. Update database with new encrypted_key and new_key_id
    # 3. Use transactions to ensure atomicity

    raise NotImplementedError("Key rotation not yet implemented")


# ============================================================================
# USAGE EXAMPLES
# ============================================================================

if __name__ == "__main__":
    """
    Usage examples (for documentation only - DO NOT run in production).
    """

    # Generate a new encryption key
    # print("New encryption key:", generate_new_encryption_key())

    # Encrypt a key
    # encrypted = encrypt_api_key("sk-ant-api03-abcdefg123456")
    # print("Encrypted:", encrypted)

    # Decrypt a key
    # decrypted = decrypt_api_key(encrypted)
    # print("Decrypted:", mask_api_key(decrypted))  # Never print plaintext!

    pass
