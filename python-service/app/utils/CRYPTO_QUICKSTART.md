# Crypto Module - Quick Start Guide

Quick reference for using the API key encryption utilities.

## Table of Contents

- [Setup](#setup)
- [Common Operations](#common-operations)
- [Quick Examples](#quick-examples)
- [Security Checklist](#security-checklist)

## Setup

### 1. Generate Encryption Key

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

### 2. Add to `.env`

```bash
ENCRYPTION_KEY=your-generated-key-here
ENCRYPTION_KEY_ID=v1
```

### 3. Import Functions

```python
from app.utils import (
    encrypt_api_key,
    decrypt_api_key,
    mask_api_key,
    store_encrypted_key,
    retrieve_decrypted_key,
    revoke_api_key,
)
```

## Common Operations

### Store a New API Key

```python
from uuid import UUID
from app.utils import store_encrypted_key

credential = store_encrypted_key(
    user_id=UUID("user-uuid"),
    provider_id=UUID("provider-uuid"),
    credential_name="My API Key",
    plaintext_api_key="sk-ant-api03-actual-key",
    metadata={"organization_id": "org-123"}  # optional
)
# Returns: {'id': '...', 'encrypted_api_key': '***encrypted***', ...}
```

### Retrieve and Use a Key

```python
from app.utils import retrieve_decrypted_key

# Retrieve
plaintext_key, metadata = retrieve_decrypted_key(
    user_id=user_id,
    provider_id=provider_id,
    credential_name="My API Key"  # optional - returns first active if omitted
)

# Use immediately
import anthropic
client = anthropic.Anthropic(api_key=plaintext_key)
response = client.messages.create(...)

# Key automatically garbage collected when out of scope
```

### List User's Keys

```python
from app.utils import list_user_credentials

credentials = list_user_credentials(
    user_id=user_id,
    include_inactive=False
)

for cred in credentials:
    print(f"{cred['credential_name']}: {cred['encrypted_api_key']}")
    # Output: "My API Key: ***encrypted***"
```

### Mask Key for Display

```python
from app.utils import mask_api_key

masked = mask_api_key("sk-ant-api03-abcdefghijklmnop1234")
# Returns: "sk-ant-...mnop1234"

# Use in API responses
response_data = {
    "credential_id": cred_id,
    "masked_key": masked,  # Safe to send to frontend
}
```

### Revoke a Key

```python
from app.utils import revoke_api_key

revoke_api_key(
    user_id=user_id,
    credential_id=credential_id,
    reason="user_requested"
)
# Key deactivated but retained in database for audit
```

### Validate a Key

```python
from app.utils import update_credential_validation_status
import anthropic

try:
    # Test the key
    client = anthropic.Anthropic(api_key=plaintext_key)
    client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=10,
        messages=[{"role": "user", "content": "test"}]
    )

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
        error_message=str(e)
    )
```

## Quick Examples

### Example 1: Data Collector Using Encrypted Key

```python
"""Anthropic data collector with encrypted key retrieval."""

from app.utils import retrieve_decrypted_key
import anthropic
import logging

logger = logging.getLogger(__name__)

def collect_anthropic_costs(user_id, provider_id):
    """Collect cost data from Anthropic API."""
    try:
        # Retrieve decrypted key
        api_key, metadata = retrieve_decrypted_key(
            user_id=user_id,
            provider_id=provider_id
        )

        # Use key immediately
        client = anthropic.Anthropic(api_key=api_key)

        # Fetch usage data
        # (Note: Actual Anthropic Admin API endpoint may differ)
        # This is conceptual example
        usage_data = client.admin.usage.list(
            start_date="2026-02-01",
            end_date="2026-02-11"
        )

        # Process and store usage data
        # ...

        logger.info(f"Collected {len(usage_data)} cost records")

        # api_key is automatically garbage collected here
        return usage_data

    except Exception as e:
        logger.error(f"Failed to collect costs: {type(e).__name__}")
        raise
```

### Example 2: FastAPI Endpoint for Storing Keys

```python
"""FastAPI endpoint for users to add API keys."""

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from uuid import UUID
from app.utils import store_encrypted_key, mask_api_key
import anthropic

router = APIRouter()

class AddKeyRequest(BaseModel):
    provider_id: UUID
    credential_name: str
    api_key: str

@router.post("/api/credentials")
async def add_api_credential(
    request: AddKeyRequest,
    current_user_id: UUID = Depends(get_current_user)  # from auth
):
    """
    Add a new API credential for the current user.

    Security: API key is encrypted before storage.
    """
    try:
        # Optional: Validate key works before storing
        if "anthropic" in request.provider_id:
            try:
                client = anthropic.Anthropic(api_key=request.api_key)
                # Minimal validation call
                client.messages.create(
                    model="claude-3-haiku-20240307",
                    max_tokens=1,
                    messages=[{"role": "user", "content": "test"}]
                )
            except Exception:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid API key - validation failed"
                )

        # Store encrypted key
        credential = store_encrypted_key(
            user_id=current_user_id,
            provider_id=request.provider_id,
            credential_name=request.credential_name,
            plaintext_api_key=request.api_key
        )

        # Return with masked key
        return {
            "id": credential["id"],
            "credential_name": credential["credential_name"],
            "masked_key": mask_api_key(request.api_key),
            "is_active": credential["is_active"],
            "created_at": credential["created_at"]
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

### Example 3: Frontend React Component

```typescript
// Frontend component for displaying API keys
interface Credential {
  id: string;
  credential_name: string;
  masked_key: string;
  is_active: boolean;
  validation_status: string;
}

function ApiKeyList() {
  const [credentials, setCredentials] = useState<Credential[]>([]);

  useEffect(() => {
    // Fetch user's credentials
    fetch('/api/credentials')
      .then(res => res.json())
      .then(data => setCredentials(data));
  }, []);

  return (
    <div>
      <h2>Your API Keys</h2>
      {credentials.map(cred => (
        <div key={cred.id}>
          <strong>{cred.credential_name}</strong>
          <code>{cred.masked_key}</code> {/* e.g., "sk-ant-...3456" */}
          <span>{cred.validation_status}</span>
          <button onClick={() => revokeKey(cred.id)}>Revoke</button>
        </div>
      ))}
    </div>
  );
}
```

## Security Checklist

When using the crypto module, ensure:

- [ ] ✅ ENCRYPTION_KEY is set in environment variables
- [ ] ✅ Never log plaintext API keys
- [ ] ✅ Never return plaintext keys in API responses
- [ ] ✅ Use `mask_api_key()` for displaying keys in UI
- [ ] ✅ Retrieve keys only when needed (just-in-time decryption)
- [ ] ✅ Don't store decrypted keys in class attributes or global variables
- [ ] ✅ Validate API keys after storage
- [ ] ✅ Use `revoke_api_key()` instead of permanent deletion
- [ ] ✅ Review audit logs regularly
- [ ] ✅ Rotate ENCRYPTION_KEY periodically (every 90 days recommended)

## Common Mistakes to Avoid

### ❌ DON'T: Store decrypted keys

```python
# BAD - decrypted key stored in memory too long
class Collector:
    def __init__(self, user_id):
        self.api_key = retrieve_decrypted_key(user_id, ...)  # ❌
```

### ✅ DO: Retrieve keys just-in-time

```python
# GOOD - key retrieved only when needed
class Collector:
    def __init__(self, user_id, provider_id):
        self.user_id = user_id
        self.provider_id = provider_id

    def collect_data(self):
        api_key, _ = retrieve_decrypted_key(self.user_id, self.provider_id)
        # Use api_key immediately
        # Key discarded when function exits
```

### ❌ DON'T: Log plaintext keys

```python
# BAD - exposes key in logs
logger.info(f"Using API key: {api_key}")  # ❌
print(f"Key: {api_key}")  # ❌
```

### ✅ DO: Log with masking

```python
# GOOD - logs only masked version
logger.info(f"Using API key: {mask_api_key(api_key)}")  # ✅
```

### ❌ DON'T: Return plaintext keys in responses

```python
# BAD - exposes key to client
return {"api_key": plaintext_key}  # ❌
```

### ✅ DO: Return masked keys

```python
# GOOD - returns masked version
return {"masked_key": mask_api_key(plaintext_key)}  # ✅
```

### ❌ DON'T: Catch exceptions silently

```python
# BAD - hides encryption failures
try:
    encrypted = encrypt_api_key(key)
except:
    pass  # ❌
```

### ✅ DO: Handle errors explicitly

```python
# GOOD - proper error handling
try:
    encrypted = encrypt_api_key(key)
except EncryptionError as e:
    logger.error("Encryption failed")
    raise HTTPException(status_code=500, detail="Failed to store key")
```

## Testing

Run tests with:

```bash
# Unit tests (mocked database)
pytest app/utils/test_crypto.py -v

# Integration tests (requires database)
pytest app/utils/test_crypto.py -v -m integration

# Coverage report
pytest app/utils/test_crypto.py --cov=app.utils.crypto --cov-report=html
```

## Additional Resources

- Full documentation: [KEY_MANAGEMENT.md](./KEY_MANAGEMENT.md)
- Security best practices: See "Security Best Practices" section in KEY_MANAGEMENT.md
- Key rotation guide: See "Key Rotation" section in KEY_MANAGEMENT.md

## Support

Questions? Check:
1. This quick start guide
2. [KEY_MANAGEMENT.md](./KEY_MANAGEMENT.md) for detailed documentation
3. [test_crypto.py](./test_crypto.py) for usage examples
4. Team security lead

---

**Remember**: Treat decrypted API keys like passwords. Never log, display, or expose them.
