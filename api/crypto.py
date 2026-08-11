"""Phase 5 — encryption at rest for medical records.

Prescriptions, consultation messages and verification documents are encrypted before they are
written to the database and decrypted when read back, so the stored data is ciphertext even if the
database file/dump is stolen. Uses Fernet (AES-128-CBC + HMAC authentication) from `cryptography`.

The key is derived from EPHARMA_ENC_KEY. A demo default keeps the app zero-config; in production set
a real secret and manage it with a secrets manager (and rotate it), never commit it.
"""
import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken

_secret = os.environ.get("EPHARMA_ENC_KEY", "epharma-demo-key-change-in-production")
# Fernet needs a 32-byte urlsafe-base64 key; derive one deterministically from the secret.
_key = base64.urlsafe_b64encode(hashlib.sha256(_secret.encode()).digest())
_f = Fernet(_key)

_PREFIX = "enc:"  # marks a value as ciphertext, so decrypt() can pass through legacy/plaintext safely


def encrypt(s):
    """Encrypt a string for storage (None stays None). Returns 'enc:<token>'."""
    if s is None:
        return None
    return _PREFIX + _f.encrypt(s.encode()).decode()


def decrypt(s):
    """Decrypt a value produced by encrypt(). Anything not marked 'enc:' (e.g. old plaintext) is
    returned unchanged, so mixed data and demos keep working."""
    if isinstance(s, str) and s.startswith(_PREFIX):
        try:
            return _f.decrypt(s[len(_PREFIX):].encode()).decode()
        except InvalidToken:
            return s
    return s
