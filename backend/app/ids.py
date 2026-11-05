"""Prefixed, unguessable identifiers (e.g. ``qt_3f9c...``) and token helpers."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def new_request_id() -> str:
    """Durable operation identity sent as PayPal-Request-Id."""
    return str(uuid.uuid4())


def new_token(nbytes: int = 24) -> str:
    return secrets.token_urlsafe(nbytes)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def hmac_hex(key: str, message: str) -> str:
    return hmac.new(key.encode(), message.encode(), hashlib.sha256).hexdigest()


def constant_time_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
