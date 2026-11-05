"""Request dependencies: the account session cookie, shop staff context, platform admin and rate limits."""

from __future__ import annotations

import re
import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable

from fastapi import Request, Response
from sqlalchemy import select

from app.config import settings
from app.db import transaction
from app.errors import Forbidden, RateLimited, Unauthorized
from app.ids import new_token
from app.models import Membership, Merchant
from app.services import accounts
from app.services.access import StaffContext, require_role
from app.services.accounts import SessionUser

AUTH_COOKIE = "lc_auth"
# Anonymous shopper session: owns baskets, holds and guest orders. Separate from sign-in, so
# a guest can check out and a signed-in shopper's baskets survive signing out.
SHOPPER_COOKIE = "lc_sid"
_SID = re.compile(r"^[A-Za-z0-9_-]{24,64}$")


def is_https(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto") if settings().trust_proxy else None
    return (proto or request.url.scheme) == "https"


def client_ip(request: Request) -> str:
    if settings().trust_proxy:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def user_agent(request: Request) -> str:
    return request.headers.get("user-agent", "")[:200]


def set_auth_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(AUTH_COOKIE, token, max_age=int(accounts.SESSION_TTL.total_seconds()), httponly=True, samesite="lax",
                        secure=is_https(request), path="/")


def clear_auth_cookie(request: Request, response: Response) -> None:
    response.delete_cookie(AUTH_COOKIE, path="/", secure=is_https(request), httponly=True, samesite="lax")


def shopper_session(request: Request, response: Response) -> str:
    sid = request.cookies.get(SHOPPER_COOKIE)
    if not sid or not _SID.match(sid):
        sid = new_token(24)
        response.set_cookie(SHOPPER_COOKIE, sid, max_age=60 * 60 * 24 * 30, httponly=True, samesite="lax", secure=is_https(request), path="/")
    request.state.session_id = sid
    return sid


def optional_shopper_session(request: Request) -> str | None:
    sid = request.cookies.get(SHOPPER_COOKIE)
    return sid if sid and _SID.match(sid) else None


def optional_user(request: Request) -> SessionUser | None:
    if not hasattr(request.state, "user"):
        request.state.user = accounts.resolve_session(request.cookies.get(AUTH_COOKIE))
    return request.state.user


def current_user(request: Request) -> SessionUser:
    user = optional_user(request)
    if user is None:
        raise Unauthorized("Sign in to continue", code="auth_required")
    return user


def platform_admin(request: Request) -> SessionUser:
    user = current_user(request)
    if not user.is_platform_admin:
        raise Forbidden("This area is limited to LastCall administrators", code="platform_admin_only")
    return user


def _staff_context(request: Request) -> StaffContext:
    user = current_user(request)
    with transaction() as db:
        stmt = (select(Membership, Merchant).join(Merchant, Merchant.id == Membership.merchant_id)
                .where(Membership.user_id == user.user_id))
        row = None
        if user.active_merchant_id:
            row = db.execute(stmt.where(Membership.merchant_id == user.active_merchant_id)).first()
        if row is None:
            row = db.execute(stmt.order_by(Membership.created_at).limit(1)).first()
        if row is None:
            raise Forbidden("Your account isn't part of a shop yet", code="no_shop")
        member, shop = row
        ctx = StaffContext(id=user.user_id, email=user.email, display_name=user.display_name, role=member.role, merchant_id=shop.id,
                           merchant_slug=shop.slug, merchant_status=shop.status, is_platform_admin=user.is_platform_admin)
    request.state.staff = ctx
    return ctx


def staff_role(role: str = "staff") -> Callable[[Request], StaffContext]:
    """The signed-in member's context for the shop their console is open on, at ``role`` or above."""

    def dependency(request: Request) -> StaffContext:
        ctx = _staff_context(request)
        require_role(ctx, role)
        return ctx

    return dependency


class _Limiter:
    """Sliding-window counter per key. Per process: right for a single API instance; account
    lockout (stored in the database) protects sign-in across instances."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window: float) -> bool:
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > window:
                hits.popleft()
            if len(hits) >= limit:
                return False
            hits.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = _Limiter()


def rate_limit(bucket: str, limit: int, window_seconds: float = 60) -> Callable[[Request], None]:
    def dependency(request: Request) -> None:
        if settings().app_env == "test" and not getattr(request.app.state, "enforce_rate_limits", False):
            return
        if not limiter.allow(f"{bucket}:{client_ip(request)}", limit, window_seconds):
            raise RateLimited("Too many requests; please slow down and try again shortly", code="rate_limited")

    return dependency
