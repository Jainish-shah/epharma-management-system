"""Encryption at rest for medical records, with support for key rotation.

Prescriptions, consultation messages and verification documents are encrypted before they are
written to the database and decrypted when read back, so the stored data is ciphertext even if the
database file/dump is stolen. Uses Fernet (AES-128-CBC + HMAC authentication) from `cryptography`.

Keys come from the environment:
    EPHARMA_ENC_KEY       the current key — everything is encrypted with this one
    EPHARMA_ENC_KEY_OLD   optional, comma-separated previous keys, kept only so existing records
                          can still be read while they are being re-encrypted

Rotating a key is therefore: set EPHARMA_ENC_KEY to the new secret, move the previous secret into
EPHARMA_ENC_KEY_OLD, deploy, then run `python manage.py rotate_encryption_key` to re-encrypt
existing rows. Once that finishes, EPHARMA_ENC_KEY_OLD can be removed.

A demo default keeps the app zero-config; in production set a real secret, manage it with a secrets
manager, and never commit it.
"""
import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

_PREFIX = "enc:"  # marks a value as ciphertext, so decrypt() can pass through legacy/plaintext safely
_DEMO_SECRET = "epharma-demo-key-change-in-production"


def _fernet_for(secret):
    """Fernet needs a 32-byte urlsafe-base64 key; derive one deterministically from the secret."""
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))


def _load():
    current = os.environ.get("EPHARMA_ENC_KEY") or _DEMO_SECRET
    old = [s.strip() for s in (os.environ.get("EPHARMA_ENC_KEY_OLD") or "").split(",") if s.strip()]
    # MultiFernet encrypts with the first key and tries the rest when decrypting, which is exactly
    # what a rotation needs: new writes use the new key, old rows still open with the previous one.
    return _fernet_for(current), MultiFernet([_fernet_for(current)] + [_fernet_for(s) for s in old])


_current, _multi = _load()


def encrypt(s):
    """Encrypt a string for storage with the CURRENT key (None stays None). Returns 'enc:<token>'."""
    if s is None:
        return None
    return _PREFIX + _current.encrypt(s.encode()).decode()


def decrypt(s):
    """Decrypt a value produced by encrypt(), trying the current key and then any retired keys.
    Anything not marked 'enc:' (e.g. data written before encryption was introduced) is returned
    unchanged, so mixed data and demos keep working."""
    if isinstance(s, str) and s.startswith(_PREFIX):
        try:
            return _multi.decrypt(s[len(_PREFIX):].encode()).decode()
        except InvalidToken:
            return s
    return s


def needs_rotation(s):
    """True when a stored value is ciphertext that the CURRENT key cannot read — i.e. it is still
    encrypted under a retired key and should be re-encrypted."""
    if not (isinstance(s, str) and s.startswith(_PREFIX)):
        return False
    try:
        _current.decrypt(s[len(_PREFIX):].encode())
        return False
    except InvalidToken:
        return True
