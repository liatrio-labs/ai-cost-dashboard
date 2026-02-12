"""Utility modules."""

from app.utils.supabase_client import get_supabase_client, test_connection
from app.utils.scheduler import get_scheduler, start_scheduler, shutdown_scheduler, CollectionScheduler
from app.utils.crypto import (
    encrypt_api_key,
    decrypt_api_key,
    mask_api_key,
    store_encrypted_key,
    retrieve_decrypted_key,
    revoke_api_key,
    delete_api_key_permanently,
    list_user_credentials,
    update_credential_validation_status,
    generate_new_encryption_key,
    EncryptionError,
    DecryptionError,
    KeyNotFoundError,
    CryptoError,
)

__all__ = [
    "get_supabase_client",
    "test_connection",
    "get_scheduler",
    "start_scheduler",
    "shutdown_scheduler",
    "CollectionScheduler",
    "encrypt_api_key",
    "decrypt_api_key",
    "mask_api_key",
    "store_encrypted_key",
    "retrieve_decrypted_key",
    "revoke_api_key",
    "delete_api_key_permanently",
    "list_user_credentials",
    "update_credential_validation_status",
    "generate_new_encryption_key",
    "EncryptionError",
    "DecryptionError",
    "KeyNotFoundError",
    "CryptoError",
]
