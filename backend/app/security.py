"""Password hashing (argon2id) and keyed hashes for opaque tokens.

Session, invite and reset tokens are random; only an HMAC under the server secret is stored,
so a database leak doesn't hand out working tokens.
"""

from __future__ import annotations

import hashlib
import hmac

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.config import settings

_hasher = PasswordHasher()
# Verified against when an email is unknown, so a miss costs the same time as a wrong password.
_DUMMY_HASH = _hasher.hash("lastcall-timing-equalizer")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, stored: str | None) -> bool:
    try:
        return _hasher.verify(stored or _DUMMY_HASH, password) and stored is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored: str) -> bool:
    return _hasher.check_needs_rehash(stored)


def token_hash(token: str, purpose: str = "token") -> str:
    key = settings().resolved_secret_key().encode()
    return hmac.new(key, f"{purpose}:{token}".encode(), hashlib.sha256).hexdigest()
