"""Password hashing (argon2id), keyed hashes for opaque tokens, and pickup codes.

Session, invite, reset and order-access tokens are random; only an HMAC under the server
secret is stored, so a database leak doesn't hand out working tokens. Pickup codes are never
stored either: the code is an HMAC of the order id and a per-order salt, and only a hash of
it is kept for verification at handoff.
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


def pickup_code(order_id: str, salt: str) -> str:
    """Four-digit code shown on the customer's pickup pass."""
    key = settings().resolved_secret_key().encode()
    digest = hmac.new(key, f"pickup:{order_id}:{salt}".encode(), hashlib.sha256).digest()
    return f"{int.from_bytes(digest[:4], 'big') % 10_000:04d}"


def pickup_code_hash(order_id: str, code: str) -> str:
    key = settings().resolved_secret_key().encode()
    return hmac.new(key, f"pickup-verify:{order_id}:{code}".encode(), hashlib.sha256).hexdigest()


def verify_pickup_code(order_id: str, code: str, stored_hash: str) -> bool:
    normalized = "".join(ch for ch in code if ch.isdigit())
    return hmac.compare_digest(pickup_code_hash(order_id, normalized), stored_hash)
