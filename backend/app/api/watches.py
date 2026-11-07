"""Watch for me (A2): a signed-in shopper's standing requests, the email link that holds a match, and the stop link."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator

from app.api.deps import current_user, rate_limit, shopper_session
from app.services import watches
from app.services.accounts import SessionUser

router = APIRouter(prefix="/api", tags=["watches"])


class WatchRequest(BaseModel):
    text: str | None = Field(default=None, max_length=600)
    shop: str | None = Field(default=None, max_length=80)
    # Watch what the shopper asked the concierge for.
    conversation_id: str | None = Field(default=None, max_length=40)

    @model_validator(mode="after")
    def _one_source(self) -> WatchRequest:
        if not (self.text or self.conversation_id):
            raise ValueError("Send what to watch for, or a conversation")
        return self


class WatchStatus(BaseModel):
    status: Literal["active", "paused"]


class StopRequest(BaseModel):
    token: str = Field(min_length=10, max_length=64)


@router.get("/me/watches")
def list_watches(user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    return watches.list_for(user)


@router.post("/me/watches", dependencies=[Depends(rate_limit("agent", 20))])
def create_watch(req: WatchRequest, user: SessionUser = Depends(current_user), session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    return watches.create(user, session_id, text=req.text, shop=req.shop, conversation_id=req.conversation_id)


@router.patch("/me/watches/{watch_id}")
def update_watch(watch_id: str, req: WatchStatus, user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    return watches.set_status(user, watch_id, req.status)


@router.delete("/me/watches/{watch_id}")
def delete_watch(watch_id: str, user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    watches.set_status(user, watch_id, "stopped")
    return {"stopped": True}


@router.get("/me/alerts")
def list_alerts(user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    return watches.alerts(user)


@router.get("/me/alerts/unread")
def unread_alerts(user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    return {"unread": watches.unread_count(user)}


@router.post("/me/alerts/seen")
def seen_alerts(user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    return watches.mark_seen(user)


@router.post("/me/alerts/{match_id}/dismiss")
def dismiss_alert(match_id: str, user: SessionUser = Depends(current_user)) -> dict[str, Any]:
    return watches.dismiss(user, match_id)


@router.post("/watches/matches/{match_id}/open", dependencies=[Depends(rate_limit("checkout", 30))])
def open_match(match_id: str, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    """The email's link (the unguessable match id is the credential): a fresh quote for this browser."""
    return watches.open_match(match_id, session_id)


@router.post("/watches/stop")
def stop_watch(req: StopRequest) -> dict[str, Any]:
    return watches.stop_by_token(req.token)
