"""Shopping concierge (A1): a shopper sends a message; the agent answers in the background and the page polls."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel, Field

from app.api.deps import optional_user, rate_limit, shopper_session
from app.services import concierge
from app.services.accounts import SessionUser

router = APIRouter(prefix="/api", tags=["concierge"])


class MessageRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    conversation_id: str | None = Field(default=None, max_length=40)
    # Storefront slug when the chat is opened on one shop's page.
    shop: str | None = Field(default=None, max_length=80)


@router.post("/concierge/messages", dependencies=[Depends(rate_limit("agent", 20))])
def post_message(req: MessageRequest, background: BackgroundTasks, session_id: str = Depends(shopper_session),
                 user: SessionUser | None = Depends(optional_user)) -> dict[str, Any]:
    conversation = concierge.send(session_id, user.user_id if user else None, req.text, req.conversation_id, req.shop)
    background.add_task(concierge.run_turn, conversation["id"])
    return conversation


@router.get("/concierge/{conversation_id}")
def get_conversation(conversation_id: str, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    return concierge.get(session_id, conversation_id)
