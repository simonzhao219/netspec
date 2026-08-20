"""Symmetric encryption for sensitive values stored in DB."""

import base64
import hashlib
from cryptography.fernet import Fernet


def _fernet(secret_key: str) -> Fernet:
    # Derive a 32-byte key from the secret_key string
    key = hashlib.sha256(secret_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(value: str, secret_key: str) -> str:
    return _fernet(secret_key).encrypt(value.encode()).decode()


def decrypt(token: str, secret_key: str) -> str:
    return _fernet(secret_key).decrypt(token.encode()).decode()
