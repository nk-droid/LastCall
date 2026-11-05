"""Accounts: sign-up, sign-in with lockout, sliding sessions, password reset and change.

One account serves a person as a shopper and, through memberships, as staff of any number
of shops. Error messages never reveal whether an email is registered.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.errors import Conflict, Forbidden, NotFound, Unauthorized, Unprocessable
from app.ids import new_id, new_token
from app.models import Membership, Merchant, PasswordReset, User, UserSession
from app.security import hash_password, needs_rehash, token_hash, verify_password
from app.services import audit, mail

SESSION_TTL = timedelta(days=14)
SESSION_REFRESH_AFTER = timedelta(hours=1)
RESET_TTL = timedelta(hours=1)
MAX_FAILED_LOGINS = 5
LOCKOUT = timedelta(minutes=15)
MIN_PASSWORD_LENGTH = 10
_COMMON = {"password123", "1234567890", "qwertyuiop", "letmein123", "iloveyou12", "password12", "lastcall123"}


def normalize_email(email: str) -> str:
    return email.strip().lower()


def validate_password(password: str, email: str, field: str = "password") -> None:
    problem = None
    if len(password) < MIN_PASSWORD_LENGTH:
        problem = f"Use at least {MIN_PASSWORD_LENGTH} characters"
    elif len(password) > 200:
        problem = "Use at most 200 characters"
    elif password.lower() in _COMMON or password.lower() == normalize_email(email) or len(set(password)) < 4:
        problem = "Choose a less common password"
    if problem:
        raise Unprocessable(problem, code="validation_error", details=[{"field": field, "message": problem}])


@dataclass(frozen=True)
class SessionUser:
    """A resolved session: the account plus the shop its console is pointed at."""

    session_id: str
    user_id: str
    email: str
    display_name: str
    is_platform_admin: bool
    active_merchant_id: str | None


# --------------------------------------------------------------------------- sessions


def _start_session(db: Session, user: User, user_agent: str) -> str:
    token = new_token(32)
    now = clock.now()
    first_shop = db.scalar(select(Membership.merchant_id).where(Membership.user_id == user.id).order_by(Membership.created_at).limit(1))
    db.add(UserSession(id=new_id("ses"), user_id=user.id, token_hash=token_hash(token, "session"), active_merchant_id=first_shop,
                       user_agent=user_agent[:200], expires_at=now + SESSION_TTL, last_seen_at=now))
    user.last_login_at = now
    return token


def resolve_session(token: str | None) -> SessionUser | None:
    if not token:
        return None
    now = clock.now()
    with transaction() as db:
        row = db.execute(
            select(UserSession, User).join(User, User.id == UserSession.user_id)
            .where(UserSession.token_hash == token_hash(token, "session"))
        ).first()
        if row is None:
            return None
        session, user = row
        if session.revoked_at is not None or session.expires_at <= now or not user.active:
            return None
        if now - session.last_seen_at >= SESSION_REFRESH_AFTER:
            session.last_seen_at = now
            session.expires_at = now + SESSION_TTL
        return SessionUser(session.id, user.id, user.email, user.display_name, user.is_platform_admin, session.active_merchant_id)


def revoke_session(token: str | None) -> None:
    if not token:
        return
    with transaction() as db:
        db.execute(update(UserSession).where(UserSession.token_hash == token_hash(token, "session"), UserSession.revoked_at.is_(None))
                   .values(revoked_at=clock.now()))


def _revoke_all(db: Session, user_id: str, except_session: str | None = None) -> None:
    stmt = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    if except_session:
        stmt = stmt.where(UserSession.id != except_session)
    db.execute(stmt.values(revoked_at=clock.now()))


# --------------------------------------------------------------------------- sign-up / sign-in


def _create_user(db: Session, *, email: str, name: str, password: str | None, actor: str, phone: str = "") -> User:
    email = normalize_email(email)
    if db.scalar(select(User.id).where(User.email == email)):
        raise Conflict("An account with this email already exists. Sign in instead.", code="email_taken",
                       details=[{"field": "email", "message": "An account with this email already exists"}])
    if password is not None:
        validate_password(password, email)
    user = User(id=new_id("usr"), email=email, display_name=name.strip(), phone=phone.strip(),
                password_hash=hash_password(password) if password is not None else None)
    db.add(user)
    db.flush()
    audit.record(db, actor=actor, actor_role="user", entity_type="user", entity_id=user.id, action="account_created")
    return user


def signup(*, email: str, name: str, password: str, user_agent: str = "") -> tuple[str, dict[str, Any]]:
    with transaction() as db:
        user = _create_user(db, email=email, name=name, password=password, actor="self")
        token = _start_session(db, user, user_agent)
        return token, account_view(db, user.id)


def login(*, email: str, password: str, user_agent: str = "") -> tuple[str, dict[str, Any]]:
    email = normalize_email(email)
    now = clock.now()
    with transaction() as db:
        user = db.scalar(select(User).where(User.email == email).with_for_update())
        if user is not None and user.locked_until and user.locked_until > now:
            verify_password(password, None)  # keep timing uniform
            minutes = max(1, int((user.locked_until - now).total_seconds() // 60) + 1)
            raise Unauthorized(f"Too many failed attempts. Try again in {minutes} minute{'s' if minutes != 1 else ''}.", code="account_locked")
        password_ok = verify_password(password, user.password_hash if user else None)  # always runs, so timing doesn't reveal accounts
        if user is None or not user.active or not password_ok:
            if user is not None:
                user.failed_logins += 1
                if user.failed_logins >= MAX_FAILED_LOGINS:
                    user.locked_until = now + LOCKOUT
                    user.failed_logins = 0
                    audit.record(db, actor="system:auth", actor_role="system", entity_type="user", entity_id=user.id, action="account_locked")
        else:
            user.failed_logins = 0
            user.locked_until = None
            if needs_rehash(user.password_hash or ""):
                user.password_hash = hash_password(password)
            token = _start_session(db, user, user_agent)
            audit.record(db, actor=f"user:{user.id}", actor_role="user", entity_type="user", entity_id=user.id, action="signed_in")
            return token, account_view(db, user.id)
    raise Unauthorized("Email or password is incorrect", code="invalid_credentials")


def account_view(db: Session, user_id: str, active_merchant_id: str | None = None) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise NotFound("Account not found")
    rows = db.execute(
        select(Membership, Merchant).join(Merchant, Merchant.id == Membership.merchant_id)
        .where(Membership.user_id == user_id).order_by(Merchant.name)
    ).all()
    memberships = [{"membership_id": m.id, "role": m.role,
                    "shop": {"id": s.id, "slug": s.slug, "name": s.name, "category": s.category, "status": s.status}} for m, s in rows]
    initials = "".join(part[0] for part in user.display_name.split()[:2]).upper() or user.email[0].upper()
    return {
        "user": {"id": user.id, "email": user.email, "name": user.display_name, "phone": user.phone, "initials": initials,
                 "is_platform_admin": user.is_platform_admin},
        "memberships": memberships,
        "active_shop_id": active_merchant_id or (memberships[0]["shop"]["id"] if memberships else None),
    }


def me(current: SessionUser) -> dict[str, Any]:
    with transaction() as db:
        return account_view(db, current.user_id, current.active_merchant_id)


def update_profile(current: SessionUser, *, name: str | None, phone: str | None) -> dict[str, Any]:
    with transaction() as db:
        user = db.get(User, current.user_id)
        if name is not None:
            user.display_name = name.strip()
        if phone is not None:
            user.phone = phone.strip()
        return account_view(db, user.id, current.active_merchant_id)


def set_active_shop(current: SessionUser, merchant_id: str) -> dict[str, Any]:
    with transaction() as db:
        member = db.scalar(select(Membership).where(Membership.user_id == current.user_id, Membership.merchant_id == merchant_id))
        if member is None:
            raise Forbidden("You're not a member of that shop", code="not_a_member")
        session = db.get(UserSession, current.session_id)
        session.active_merchant_id = merchant_id
        return account_view(db, current.user_id, merchant_id)


# --------------------------------------------------------------------------- passwords


def _issue_reset(db: Session, user: User) -> str:
    token = new_token(32)
    db.execute(update(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))
               .values(used_at=clock.now()))  # only the newest link works
    db.add(PasswordReset(id=new_id("pwr"), user_id=user.id, token_hash=token_hash(token, "reset"), expires_at=clock.now() + RESET_TTL))
    return mail.app_link(f"/reset-password/{token}")


def forgot_password(email: str) -> None:
    """Queue a reset email if the account exists. The response is the same either way."""
    with transaction() as db:
        user = db.scalar(select(User).where(User.email == normalize_email(email), User.active.is_(True)))
        if user is None:
            return
        link = _issue_reset(db, user)
        mail.queue(db, to=user.email, template="password_reset", context={"name": user.display_name}, link=link)
        audit.record(db, actor="self", actor_role="user", entity_type="user", entity_id=user.id, action="password_reset_requested")


def reset_link_for(db: Session, user_id: str, actor: str) -> str:
    """A reset link handed to a shop owner or platform admin to pass on (when email isn't set up)."""
    user = db.get(User, user_id)
    link = _issue_reset(db, user)
    audit.record(db, actor=actor, actor_role="staff", entity_type="user", entity_id=user.id, action="password_reset_link_created")
    return link


def reset_password(token: str, password: str, user_agent: str = "") -> tuple[str, dict[str, Any]]:
    now = clock.now()
    with transaction() as db:
        reset = db.scalar(select(PasswordReset).where(PasswordReset.token_hash == token_hash(token, "reset")).with_for_update())
        if reset is None or reset.used_at is not None or reset.expires_at <= now:
            raise Unprocessable("This reset link has expired or was already used. Request a new one.", code="reset_link_invalid")
        user = db.get(User, reset.user_id)
        validate_password(password, user.email)
        user.password_hash = hash_password(password)
        user.failed_logins = 0
        user.locked_until = None
        reset.used_at = now
        _revoke_all(db, user.id)
        audit.record(db, actor=f"user:{user.id}", actor_role="user", entity_type="user", entity_id=user.id, action="password_reset")
        session_token = _start_session(db, user, user_agent)
        return session_token, account_view(db, user.id)


def change_password(current: SessionUser, current_password: str, new_password: str) -> None:
    with transaction() as db:
        user = db.get(User, current.user_id)
        if not verify_password(current_password, user.password_hash):
            raise Unprocessable("Current password is incorrect", code="validation_error",
                                details=[{"field": "current_password", "message": "Current password is incorrect"}])
        validate_password(new_password, user.email, field="new_password")
        user.password_hash = hash_password(new_password)
        _revoke_all(db, user.id, except_session=current.session_id)
        audit.record(db, actor=f"user:{user.id}", actor_role="user", entity_type="user", entity_id=user.id, action="password_changed")


# --------------------------------------------------------------------------- platform admins


def ensure_platform_admin(*, email: str, name: str, password: str) -> dict[str, Any]:
    """Create (or promote) a platform administrator. Used by the CLI."""
    with transaction() as db:
        user = db.scalar(select(User).where(User.email == normalize_email(email)))
        if user is None:
            user = _create_user(db, email=email, name=name, password=password, actor="system:cli")
        else:
            validate_password(password, user.email)
            user.password_hash = hash_password(password)
        user.is_platform_admin = True
        audit.record(db, actor="system:cli", actor_role="system", entity_type="user", entity_id=user.id, action="platform_admin_granted")
        return {"id": user.id, "email": user.email}
