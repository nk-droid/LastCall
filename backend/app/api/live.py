"""Server-sent events: GET /api/live?topics=order:<id>,shop:<id>:stock,...

Every topic is authorized up front with the same rules as the matching read endpoint. The
stream carries only "something changed" notices plus a heartbeat; clients re-fetch.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.api.deps import optional_shopper_session, optional_user
from app.db import transaction
from app.errors import Forbidden, NotFound, Unprocessable
from app.models import Membership, Merchant
from app.realtime import broker
from app.services.accounts import SessionUser
from app.services.checkout import _order_access

router = APIRouter(prefix="/api", tags=["live"])

HEARTBEAT_SECONDS = 15
MAX_TOPICS = 6


def _authorize(topics: list[str], session_id: str | None, user: SessionUser | None, token: str | None) -> None:
    with transaction() as db:
        for topic in topics:
            parts = topic.split(":")
            if len(parts) == 2 and parts[0] == "order":
                _order_access(db, parts[1], session_id, token, user_id=user.user_id if user else None)
            elif len(parts) == 3 and parts[0] == "shop" and parts[2] in ("orders", "stock"):
                merchant = db.get(Merchant, parts[1])
                member = user is not None and db.scalar(select(Membership.id).where(Membership.user_id == user.user_id,
                                                                                    Membership.merchant_id == parts[1])) is not None
                if merchant is None or (parts[2] == "stock" and not (merchant.is_live or member)):
                    raise NotFound("Shop not found")
                if parts[2] == "orders" and not member:
                    raise Forbidden("Only the shop's team can follow its orders", code="not_a_member")
            else:
                raise Unprocessable(f"Unknown topic {topic}", code="invalid_topic")


@router.get("/live")
async def live(request: Request, topics: str = Query(max_length=400), t: str | None = Query(default=None, max_length=80),
               session_id: str | None = Depends(optional_shopper_session), user: SessionUser | None = Depends(optional_user)) -> StreamingResponse:
    wanted = sorted({x.strip() for x in topics.split(",") if x.strip()})
    if not wanted or len(wanted) > MAX_TOPICS:
        raise Unprocessable(f"Follow between 1 and {MAX_TOPICS} topics", code="invalid_topic")
    await asyncio.to_thread(_authorize, wanted, session_id, user, t)
    queue, unsubscribe = broker.subscribe(wanted)

    async def stream() -> AsyncIterator[str]:
        try:
            yield "retry: 5000\n\n"
            while not await request.is_disconnected():
                try:
                    topic = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                yield f"event: change\ndata: {topic}\n\n"
        finally:
            unsubscribe()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
