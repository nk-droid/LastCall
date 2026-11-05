"""A shop's team: members, roles and email invites.

Managers invite staff; owners invite anyone and change roles. A shop always keeps at least
one owner. Accepting an invite either creates the account or, for an existing account,
requires being signed in as the invited email.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.errors import Conflict, Forbidden, NotFound, Unprocessable
from app.ids import new_id, new_token
from app.models import SHOP_ROLES, Invite, Membership, Merchant, User, UserSession
from app.security import token_hash
from app.services import accounts, audit, mail
from app.services.access import ROLE_LABELS, StaffContext, assignable_roles, require_role
from app.services.accounts import SessionUser

INVITE_TTL = timedelta(days=7)


def _member_rows(db: Session, merchant_id: str) -> list[dict[str, Any]]:
    rows = db.execute(
        select(Membership, User).join(User, User.id == Membership.user_id)
        .where(Membership.merchant_id == merchant_id).order_by(Membership.created_at)
    ).all()
    return [{"membership_id": m.id, "user_id": u.id, "name": u.display_name, "email": u.email, "role": m.role,
             "role_label": ROLE_LABELS[m.role], "joined_at": clock.iso(m.created_at), "last_login_at": clock.iso(u.last_login_at)}
            for m, u in rows]


def _invite_view(invite: Invite) -> dict[str, Any]:
    return {"id": invite.id, "email": invite.email, "role": invite.role, "role_label": ROLE_LABELS[invite.role],
            "expires_at": clock.iso(invite.expires_at), "created_at": clock.iso(invite.created_at)}


def team(ctx: StaffContext) -> dict[str, Any]:
    require_role(ctx, "manager")
    now = clock.now()
    with transaction() as db:
        invites = db.scalars(select(Invite).where(Invite.merchant_id == ctx.merchant_id, Invite.accepted_at.is_(None),
                                                  Invite.revoked_at.is_(None), Invite.expires_at > now).order_by(Invite.created_at)).all()
        return {"members": _member_rows(db, ctx.merchant_id), "invites": [_invite_view(i) for i in invites],
                "assignable_roles": assignable_roles(ctx.role), "you": ctx.id}


def invite(ctx: StaffContext, email: str, role: str) -> dict[str, Any]:
    require_role(ctx, "manager")
    if role not in SHOP_ROLES:
        raise Unprocessable("Unknown role", code="validation_error", details=[{"field": "role", "message": "Choose staff, manager or owner"}])
    if role not in assignable_roles(ctx.role):
        raise Forbidden(f"Only owners can invite a {ROLE_LABELS[role].lower()}", code="insufficient_role")
    email = accounts.normalize_email(email)
    with transaction() as db:
        existing = db.scalar(select(Membership).join(User, User.id == Membership.user_id)
                             .where(Membership.merchant_id == ctx.merchant_id, User.email == email))
        if existing:
            raise Conflict("That person is already on the team", code="already_member",
                           details=[{"field": "email", "message": "Already a member of this shop"}])
        for old in db.scalars(select(Invite).where(Invite.merchant_id == ctx.merchant_id, Invite.email == email,
                                                   Invite.accepted_at.is_(None), Invite.revoked_at.is_(None))).all():
            old.revoked_at = clock.now()  # re-inviting replaces the previous link
        token = new_token(32)
        row = Invite(id=new_id("inv"), merchant_id=ctx.merchant_id, email=email, role=role, token_hash=token_hash(token, "invite"),
                     invited_by=ctx.id, expires_at=clock.now() + INVITE_TTL)
        db.add(row)
        shop = db.get(Merchant, ctx.merchant_id)
        link = mail.app_link(f"/invite/{token}")
        mail.queue(db, to=email, template="staff_invite", link=link,
                   context={"shop": shop.name, "inviter": ctx.display_name, "role_label": ROLE_LABELS[role].lower()})
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="invite", entity_id=row.id, action="invite_sent",
                     meta={"role": role, "merchant_id": ctx.merchant_id})
        db.flush()
        # The link is also returned so the inviter can share it directly.
        return {"invite": _invite_view(row), "link": link}


def revoke_invite(ctx: StaffContext, invite_id: str) -> None:
    require_role(ctx, "manager")
    with transaction() as db:
        row = db.get(Invite, invite_id)
        if row is None or row.merchant_id != ctx.merchant_id:
            raise NotFound("Invite not found")
        if row.role not in assignable_roles(ctx.role):
            raise Forbidden("Only owners can withdraw this invite", code="insufficient_role")
        row.revoked_at = clock.now()
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="invite", entity_id=row.id, action="invite_revoked")


def _load_invite(db: Session, token: str, lock: bool = False) -> Invite:
    stmt = select(Invite).where(Invite.token_hash == token_hash(token, "invite"))
    row = db.scalar(stmt.with_for_update() if lock else stmt)
    if row is None or row.revoked_at is not None or row.accepted_at is not None or row.expires_at <= clock.now():
        raise NotFound("This invitation has expired or was already used. Ask the shop for a new one.", code="invite_invalid")
    return row


def preview(token: str) -> dict[str, Any]:
    with transaction() as db:
        row = _load_invite(db, token)
        shop = db.get(Merchant, row.merchant_id)
        has_account = db.scalar(select(func.count()).select_from(User).where(User.email == row.email)) > 0
        return {"email": row.email, "role": row.role, "role_label": ROLE_LABELS[row.role], "has_account": has_account,
                "shop": {"id": shop.id, "name": shop.name, "slug": shop.slug, "category": shop.category}}


def accept(token: str, *, current: SessionUser | None, name: str | None, password: str | None,
           user_agent: str = "") -> tuple[str | None, dict[str, Any]]:
    """Returns (new session token or None if already signed in, account view)."""
    with transaction() as db:
        row = _load_invite(db, token, lock=True)
        user = db.scalar(select(User).where(User.email == row.email))
        new_session: str | None = None
        if user is not None:
            if current is None or current.user_id != user.id:
                raise Forbidden(f"Sign in as {row.email} to accept this invitation", code="sign_in_required")
        else:
            if not name or not password:
                raise Unprocessable("Add your name and a password to create your account", code="validation_error",
                                    details=[{"field": f, "message": "Required"} for f, v in (("name", name), ("password", password)) if not v])
            user = accounts._create_user(db, email=row.email, name=name, password=password, actor=f"invite:{row.id}")
            new_session = accounts._start_session(db, user, user_agent)
        db.add(Membership(id=new_id("mem"), user_id=user.id, merchant_id=row.merchant_id, role=row.role, invited_by=row.invited_by))
        row.accepted_at = clock.now()
        if current is not None:
            session = db.get(UserSession, current.session_id)
            session.active_merchant_id = row.merchant_id
        audit.record(db, actor=f"user:{user.id}", actor_role="user", entity_type="invite", entity_id=row.id, action="invite_accepted",
                     meta={"merchant_id": row.merchant_id, "role": row.role})
        db.flush()
        return new_session, accounts.account_view(db, user.id, row.merchant_id)


def _member(db: Session, ctx: StaffContext, membership_id: str) -> Membership:
    row = db.get(Membership, membership_id, with_for_update=True)
    if row is None or row.merchant_id != ctx.merchant_id:
        raise NotFound("Team member not found")
    return row


def _owners(db: Session, merchant_id: str) -> int:
    return db.scalar(select(func.count()).select_from(Membership).where(Membership.merchant_id == merchant_id, Membership.role == "owner"))


def change_role(ctx: StaffContext, membership_id: str, role: str) -> dict[str, Any]:
    require_role(ctx, "owner")
    if role not in SHOP_ROLES:
        raise Unprocessable("Unknown role", code="validation_error", details=[{"field": "role", "message": "Choose staff, manager or owner"}])
    with transaction() as db:
        row = _member(db, ctx, membership_id)
        if row.role == "owner" and role != "owner" and _owners(db, ctx.merchant_id) <= 1:
            raise Conflict("A shop needs at least one owner. Make someone else an owner first.", code="last_owner")
        before, row.role = row.role, role
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="membership", entity_id=row.id, action="role_changed",
                     meta={"from": before, "to": role})
        return {"members": _member_rows(db, ctx.merchant_id)}


def remove(ctx: StaffContext, membership_id: str) -> dict[str, Any]:
    require_role(ctx, "manager")
    with transaction() as db:
        row = _member(db, ctx, membership_id)
        if row.role not in assignable_roles(ctx.role):
            raise Forbidden("Only owners can remove managers and owners", code="insufficient_role")
        if row.role == "owner" and _owners(db, ctx.merchant_id) <= 1:
            raise Conflict("A shop needs at least one owner", code="last_owner")
        # Sessions pointed at this shop lose access on their next request.
        for session in db.scalars(select(UserSession).where(UserSession.user_id == row.user_id,
                                                            UserSession.active_merchant_id == ctx.merchant_id)).all():
            session.active_merchant_id = None
        audit.record(db, actor=ctx.actor, actor_role=ctx.role, entity_type="membership", entity_id=row.id, action="member_removed",
                     meta={"user_id": row.user_id, "role": row.role})
        db.delete(row)
        db.flush()
        return {"members": _member_rows(db, ctx.merchant_id)}


def reset_link(ctx: StaffContext, membership_id: str) -> dict[str, str]:
    """Owners can hand a teammate a password-reset link (useful before email is configured)."""
    require_role(ctx, "owner")
    with transaction() as db:
        row = _member(db, ctx, membership_id)
        return {"link": accounts.reset_link_for(db, row.user_id, ctx.actor)}
