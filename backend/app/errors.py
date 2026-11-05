"""Typed application errors, rendered as ``{"error": {"code", "message", "details"}}``."""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, details: Any = None, status: int | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status:
            self.status_code = status
        self.details = details

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            body["details"] = self.details
        return {"error": body}


class NotFound(AppError):
    status_code = 404
    code = "not_found"


class Unauthorized(AppError):
    status_code = 401
    code = "unauthorized"


class Forbidden(AppError):
    status_code = 403
    code = "forbidden"


class Conflict(AppError):
    status_code = 409
    code = "conflict"


class Unprocessable(AppError):
    status_code = 422
    code = "unprocessable"


class RateLimited(AppError):
    status_code = 429
    code = "rate_limited"


class ProviderError(AppError):
    """A payment or AI provider failed in a way the caller should surface (not a lost outcome)."""

    status_code = 502
    code = "provider_error"


class QuoteInvalid(Conflict):
    """The basket changed (stock, price, eligibility or pickup). Details carry the problems
    and, when one exists, a substitution offer the customer must explicitly accept."""

    code = "quote_invalid"
