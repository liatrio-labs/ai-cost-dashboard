# API Key Management and Security Guide

This guide covers best practices for managing API keys securely in the AI Cost Dashboard application.

## Table of Contents

1. [Overview](#overview)
2. [Encryption Architecture](#encryption-architecture)
3. [Setup Guide](#setup-guide)
4. [Usage Patterns](#usage-patterns)
5. [Security Best Practices](#security-best-practices)
6. [Key Rotation](#key-rotation)
7. [Troubleshooting](#troubleshooting)
8. [Audit Trail](#audit-trail)

## Overview

The AI Cost Dashboard uses **AES-256 encryption** (via Fernet) to secure API keys before storing them in the database. Keys are:

- ✅ Encrypted at application layer before database insertion
- ✅ Decrypted only at point of use (API calls)
- ✅ Never logged or exposed in plaintext
- ✅ Masked in UI responses (show only last 4 characters)
- ✅ Protected by Row-Level Security (RLS) in database
- ✅ Audited on every access

## Encryption Architecture

### Flow Diagram

```
User Input (Plaintext Key)
         ↓
  encrypt_api_key()
         ↓
  Encrypted String
         ↓
  Database (api_credentials table)
         ↓ (when needed)
  retrieve_decrypted_key()
         ↓
  Plaintext Key (in memory)
         ↓
  API Call (Anthropic, OpenAI)
         ↓
  Key discarded from memory
```

### Encryption Method

- **Algorithm**: Fernet (symmetric encryption)
- **Key Size**: 256 bits (32 bytes)
- **Encoding**: URL-safe base64
- **Library**: `cryptography` (Python)

Fernet provides:
- AES-256-CBC encryption
- HMAC-SHA256 authentication
- Timestamp verification
- Built-in key derivation

## Setup Guide

### 1. Generate Encryption Key

Generate a secure encryption key for your environment:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Example output:
```
mJ8kN2pR5sT7vX9yB1cD4eF6gH8iJ0kL2mN4oP6qR8sT0uV2wX4yZ6aB8cD0eF2g=
```

### 2. Set Environment Variable

Add the generated key to your `.env` file:

```bash
ENCRYPTION_KEY=mJ8kN2pR5sT7vX9yB1cD4eF6gH8iJ0kL2mN4oP6qR8sT0uV2wX4yZ6aB8cD0eF2g=
ENCRYPTION_KEY_ID=v1
```

**IMPORTANT**:
- Never commit `.env` file to version control
- Use different keys for development, staging, and production
- Store production keys in secure secret management (AWS Secrets Manager, HashiCorp Vault, etc.)

### 3. Verify Setup

Test encryption/decryption:

```python
from app.utils.crypto import encrypt_api_key, decrypt_api_key, mask_api_key

# Encrypt a test key
encrypted = encrypt_api_key("sk-ant-api03-test123456")
print("Encrypted:", encrypted)

# Decrypt it back
decrypted = decrypt_api_key(encrypted)
print("Decrypted (masked):", mask_api_key(decrypted))
```

## Usage Patterns

### Storing a New API Key

```python
from uuid import UUID
from app.utils.crypto import store_encrypted_key

# When user adds an API key through UI
user_id = UUID("123e4567-e89b-12d3-a456-426614174000")
provider_id = UUID("provider-uuid-here")

credential = store_encrypted_key(
    user_id=user_id,
    provider_id=provider_id,
    credential_name="My Anthropic Key",
    plaintext_api_key="sk-ant-api03-abcdefg123456",
    metadata={
        "organization_id": "org-123",
        "added_from_ip": "192.168.1.1"
    }
)

# Returns: {'id': '...', 'encrypted_api_key': '***encrypted***', ...}
```

### Retrieving and Using an API Key

```python
from app.utils.crypto import retrieve_decrypted_key
import anthropic

# In data collector or API call
user_id = UUID("123e4567-e89b-12d3-a456-426614174000")
provider_id = UUID("anthropic-provider-id")

# Retrieve and decrypt
plaintext_key, metadata = retrieve_decrypted_key(
    user_id=user_id,
    provider_id=provider_id
)

# Use immediately for API call
client = anthropic.Anthropic(api_key=plaintext_key)
response = client.messages.create(...)

# Key automatically discarded when out of scope
```

**CRITICAL**: Never store the decrypted key in a variable longer than necessary.

### Listing User's Credentials

```python
from app.utils.crypto import list_user_credentials

# Get all active credentials for a user
credentials = list_user_credentials(
    user_id=user_id,
    include_inactive=False
)

# Returns list with masked keys:
# [
#   {
#     'id': '...',
#     'credential_name': 'My Anthropic Key',
#     'encrypted_api_key': '***encrypted***',
#     'providers': {'name': 'anthropic', 'display_name': 'Anthropic'},
#     'is_active': True,
#     ...
#   }
# ]
```

### Revoking a Key

```python
from app.utils.crypto import revoke_api_key

# User requests to deactivate a key
revoke_api_key(
    user_id=user_id,
    credential_id=credential_id,
    reason="key_compromised"  # or "user_requested", "expired", etc.
)

# Key is deactivated but retained in database for audit trail
```

### Permanent Deletion (Dangerous)

```python
from app.utils.crypto import delete_api_key_permanently

# Only use when absolutely necessary (e.g., compliance requirement)
delete_api_key_permanently(
    user_id=user_id,
    credential_id=credential_id,
    confirmation_token="CONFIRM_DELETE"
)

# Key is permanently removed from database
```

## Security Best Practices

### 1. Never Log Plaintext Keys

**❌ NEVER DO THIS:**
```python
logger.info(f"Using API key: {plaintext_key}")  # SECURITY VIOLATION!
print(f"Key: {api_key}")  # SECURITY VIOLATION!
```

**✅ DO THIS:**
```python
logger.info("Using API key for provider X")  # OK - no key exposed
logger.info(f"Using masked key: {mask_api_key(api_key)}")  # OK - masked
```

### 2. Minimize Key Exposure Time

**❌ AVOID:**
```python
# Storing decrypted key for long period
self.api_key = retrieve_decrypted_key(...)  # Risky
```

**✅ PREFER:**
```python
# Decrypt immediately before use
plaintext_key, _ = retrieve_decrypted_key(...)
client = anthropic.Anthropic(api_key=plaintext_key)
response = client.messages.create(...)
# plaintext_key discarded after this scope
```

### 3. Handle Errors Safely

**❌ AVOID:**
```python
try:
    plaintext_key = decrypt_api_key(encrypted)
except Exception as e:
    logger.error(f"Failed to decrypt: {encrypted}")  # Exposes encrypted key
```

**✅ PREFER:**
```python
try:
    plaintext_key = decrypt_api_key(encrypted)
except DecryptionError as e:
    logger.error("Failed to decrypt API key")  # No key exposed
    # Handle error appropriately
```

### 4. Validate Keys After Storage

```python
from app.utils.crypto import update_credential_validation_status

# After storing a new key, validate it works
try:
    # Test API call with the key
    client = anthropic.Anthropic(api_key=plaintext_key)
    client.messages.create(...)  # Minimal test call

    # Mark as valid
    update_credential_validation_status(
        credential_id=credential_id,
        status="valid"
    )
except Exception as e:
    # Mark as invalid
    update_credential_validation_status(
        credential_id=credential_id,
        status="invalid",
        error_message="API validation failed"
    )
```

### 5. Use Masking in UI

Always mask keys when displaying to users:

```python
from app.utils.crypto import mask_api_key

# Frontend API response
masked = mask_api_key("sk-ant-api03-abcdefghijklmnop123456")
# Returns: "sk-ant...3456"

response = {
    "credential_id": credential_id,
    "credential_name": "My Key",
    "masked_key": masked,  # Safe to display
    # Never include plaintext key
}
```

### 6. Secure Environment Variables

**Development:**
```bash
# .env file (never commit to git)
ENCRYPTION_KEY=your-key-here
```

**Production (Render, Heroku, etc.):**
- Use platform's secret management
- Set as environment variable in dashboard
- Never hardcode in source code

**Production (AWS):**
```python
import boto3

# Retrieve from AWS Secrets Manager
client = boto3.client('secretsmanager')
secret = client.get_secret_value(SecretId='prod/encryption-key')
os.environ['ENCRYPTION_KEY'] = secret['SecretString']
```

## Key Rotation

### When to Rotate Keys

Rotate your ENCRYPTION_KEY when:
- Scheduled rotation policy (e.g., every 90 days)
- Key may have been compromised
- Team member with key access leaves
- Compliance requirements mandate rotation

### Rotation Process (Manual)

1. **Generate New Key:**
   ```bash
   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```

2. **Keep Old Key Temporarily:**
   ```bash
   ENCRYPTION_KEY_OLD=old-key-here
   ENCRYPTION_KEY=new-key-here
   ENCRYPTION_KEY_ID=v2
   ```

3. **Run Migration Script:**
   ```python
   # TODO: Implement rotate_encryption_key() function
   from app.utils.crypto import rotate_encryption_key

   old_key = os.getenv("ENCRYPTION_KEY_OLD").encode()
   new_key = os.getenv("ENCRYPTION_KEY").encode()

   count = rotate_encryption_key(
       old_key=old_key,
       new_key=new_key,
       new_key_id="v2"
   )

   print(f"Re-encrypted {count} credentials")
   ```

4. **Verify All Keys Work:**
   - Test data collectors
   - Check API calls succeed
   - Monitor error logs

5. **Remove Old Key:**
   ```bash
   unset ENCRYPTION_KEY_OLD
   ```

### Rotation Frequency

Recommended rotation schedules:
- **Development**: As needed
- **Staging**: Every 6 months
- **Production**: Every 90 days or per compliance policy

## Troubleshooting

### Error: "Missing required environment variables"

**Cause**: ENCRYPTION_KEY not set

**Solution**:
```bash
# Generate key
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# Add to .env
echo "ENCRYPTION_KEY=generated-key-here" >> .env
```

### Error: "Failed to decrypt API key: invalid token"

**Possible Causes**:
1. Wrong ENCRYPTION_KEY (key was rotated)
2. Corrupted encrypted data in database
3. Key was encrypted with different encryption key

**Solution**:
```python
# Check encryption_key_id in database
SELECT id, encryption_key_id, created_at FROM api_credentials WHERE id = '...';

# If key_id doesn't match current version, key rotation needed
```

### Error: "No active API credential found"

**Cause**: User hasn't added API key yet or key was revoked

**Solution**:
```python
# List all credentials (including inactive)
credentials = list_user_credentials(user_id=user_id, include_inactive=True)

# Check if key exists but is inactive
if credentials and not credentials[0]['is_active']:
    print("Key was revoked. User needs to add a new one.")
```

### Decryption Takes Too Long

**Cause**: Database query or network latency

**Solution**:
```python
# Cache decrypted keys in memory (CAREFULLY)
from functools import lru_cache
from datetime import datetime, timedelta

class KeyCache:
    def __init__(self, ttl_seconds=300):  # 5 minute TTL
        self._cache = {}
        self._ttl = ttl_seconds

    def get(self, key_id):
        if key_id in self._cache:
            value, expiry = self._cache[key_id]
            if datetime.now() < expiry:
                return value
            del self._cache[key_id]
        return None

    def set(self, key_id, value):
        expiry = datetime.now() + timedelta(seconds=self._ttl)
        self._cache[key_id] = (value, expiry)

# Use with extreme caution - keys in memory are vulnerable
```

## Audit Trail

### Audit Log Events

All key operations are logged:

| Event | Description | Details Logged |
|-------|-------------|----------------|
| `key_created` | New API key stored | user_id, provider_id, credential_name |
| `key_accessed` | Key retrieved and decrypted | user_id, credential_id, timestamp |
| `key_revoked` | Key deactivated | user_id, credential_id, reason |
| `key_deleted_permanently` | Key removed from database | user_id, credential_id, timestamp |
| `validation_updated` | Key validation status changed | credential_id, status (valid/invalid) |

### Viewing Audit Logs

```python
# Currently logged to application logs
# Future: Query audit_log table

# Example log entry:
# INFO: AUDIT: user=123e4567-..., credential=abc-def-...,
#       action=key_accessed, details={'credential_name': 'My Key'}
```

### Compliance

Audit logs support compliance with:
- **SOC 2**: Access logging and key rotation
- **PCI DSS**: Encryption and key management
- **GDPR**: User data access tracking
- **HIPAA**: Encryption at rest and audit trails

## Advanced Topics

### Multi-Key Encryption (Future)

Support multiple encryption keys simultaneously:

```python
# Environment
ENCRYPTION_KEYS={"v1": "key1", "v2": "key2", "v3": "key3"}
ENCRYPTION_KEY_CURRENT=v3

# Encryption uses v3
# Decryption tries v3, falls back to v2, v1 if needed
```

### Hardware Security Modules (HSM)

For enterprise deployments, integrate with HSM:

```python
# AWS CloudHSM example
import boto3

def get_encryption_key_from_hsm():
    client = boto3.client('cloudhsmv2')
    # Retrieve key from HSM
    # ...
    return key
```

### Zero-Knowledge Architecture

For maximum security, consider:
- Client-side encryption (key never sent to server)
- Server stores double-encrypted keys
- User password derives encryption key

## Support

For questions about key management:
- Review this guide first
- Check application logs for errors
- Consult the team security lead
- Open an issue in the repository

---

**Remember**: When in doubt, err on the side of caution. Never log, display, or expose plaintext API keys.
