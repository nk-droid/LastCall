"""Account endpoints: sign-up, sign-in, sessions, passwords and invitations."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr, Field

from app.api.deps import (
    AUTH_COOKIE,
    SHOPPER_COOKIE,
    clear_auth_cookie,
    current_user,
    optional_shopper_session,
    optional_user,
    rate_limit,
    set_auth_cookie,
    user_agent,
)
from app.services import accounts, orders, team
from app.services.accounts import SessionUser

router = APIRouter(prefix="/api", tags=["auth"])


class SignupBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class LoginBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class ProfileBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=40)


class ActiveShopBody(BaseModel):
    shop_id: str = Field(min_length=1, max_length=40)


class ForgotBody(BaseModel):
    email: EmailStr


class ResetBody(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class ChangePasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=1, max_length=200)


class AcceptInviteBody(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    password: str | None = Field(default=None, max_length=200)


@router.post("/auth/signup", status_code=201, dependencies=[Depends(rate_limit("signup", 10, 3600))])
def signup(body: SignupBody, request: Request, response: Response, sid: str | None = Depends(optional_shopper_session)) -> dict[str, Any]:
    token, view = accounts.signup(email=body.email, name=body.name, password=body.password, user_agent=user_agent(request))
    set_auth_cookie(request, response, token)
    orders.claim_guest_orders(view["user"]["id"], sid)
    return view


@router.post("/auth/login", dependencies=[Depends(rate_limit("login", 20, 300))])
def login(body: LoginBody, request: Request, response: Response, sid: str | None = Depends(optional_shopper_session)) -> dict[str, Any]:
    token, view = accounts.login(email=body.email, password=body.password, user_agent=user_agent(request))
    set_auth_cookie(request, response, token)
    orders.claim_guest_orders(view["user"]["id"], sid)
    return view


@router.post("/auth/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    accounts.revoke_session(request.cookies.get(AUTH_COOKIE))
    clear_auth_cookie(request, response)
    # Start a fresh shopper session too, so the next person on this browser sees none of these baskets or orders.
    response.delete_cookie(SHOPPER_COOKIE, path="/")
    return {"ok": True}


@router.get("/auth/me")
def me(user: SessionUser | None = Depends(optional_user)) -> dict[str, Any]:
    if user is None:
        return {"user": None, "memberships": [], "active_shop_id": None}
    return accounts.me(user)


@router.patch("/auth/me")
def update_me(body: ProfileBody, user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    return accounts.update_profile(user, name=body.name, phone=body.phone)


@router.post("/auth/active-shop")
def active_shop(body: ActiveShopBody, user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    return accounts.set_active_shop(user, body.shop_id)


@router.post("/auth/password/forgot", status_code=202, dependencies=[Depends(rate_limit("forgot", 5, 900))])
def forgot_password(body: ForgotBody) -> dict[str, str]:
    accounts.forgot_password(body.email)
    return {"message": "If an account exists for that email, a reset link is on its way."}


@router.post("/auth/password/reset", dependencies=[Depends(rate_limit("reset", 10, 900))])
def reset_password(body: ResetBody, request: Request, response: Response) -> dict[str, Any]:
    token, view = accounts.reset_password(body.token, body.password, user_agent=user_agent(request))
    set_auth_cookie(request, response, token)
    return view


@router.post("/auth/password/change")
def change_password(body: ChangePasswordBody, user: SessionUser = Depends(current_user)) -> dict[str, bool]:
    accounts.change_password(user, body.current_password, body.new_password)
    return {"ok": True}


@router.get("/invites/{token}", dependencies=[Depends(rate_limit("invite", 30, 300))])
def invite_preview(token: str) -> dict[str, Any]:
    return team.preview(token)


@router.post("/invites/{token}/accept", dependencies=[Depends(rate_limit("invite", 30, 300))])
def accept_invite(token: str, body: AcceptInviteBody, request: Request, response: Response,
                  user: SessionUser | None = Depends(optional_user)) -> dict[str, Any]:
    session_token, view = team.accept(token, current=user, name=body.name, password=body.password, user_agent=user_agent(request))
    if session_token:
        set_auth_cookie(request, response, session_token)
    return view
