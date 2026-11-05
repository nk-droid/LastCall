"""Shopping flow: intent parsing (L1), bundle proposals (L2), quotes, substitutions (L3), reservations."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.errors import Unprocessable
from app.services import holds, intent, quotes, recommendation, substitution

from .deps import rate_limit, shopper_session

router = APIRouter(prefix="/api", tags=["shopping"])


@router.post("/intents/parse", dependencies=[Depends(rate_limit("ai", 40))])
def parse_intent(req: intent.ParseRequest, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    result, intent_id = intent.parse(req, session_id)
    return intent.view(result, intent_id)


class ProposeRequest(BaseModel):
    intent_id: str = Field(max_length=40)


@router.post("/bundles/propose", dependencies=[Depends(rate_limit("ai", 40))])
def propose(req: ProposeRequest, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    return recommendation.propose(req.intent_id, session_id)


class SubstituteRequest(BaseModel):
    replace_sku: str | None = Field(default=None, max_length=32)
    with_sku: str | None = Field(default=None, max_length=32)


@router.post("/bundles/{quote_id}/substitute", dependencies=[Depends(rate_limit("ai", 40))])
def substitute(quote_id: str, req: SubstituteRequest, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    """Validated alternative quote plus a before/after comparison (never applied without acceptance)."""
    return substitution.propose(session_id, quote_id, replace_sku=req.replace_sku, with_sku=req.with_sku)


@router.post("/substitutions/{offer_id}/accept")
def accept_substitution(offer_id: str, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    return substitution.accept(session_id, offer_id)


@router.post("/substitutions/{offer_id}/reject")
def reject_substitution(offer_id: str, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    return substitution.reject(session_id, offer_id)


class QuoteLine(BaseModel):
    sku: str = Field(max_length=32)
    qty: int = Field(ge=1, le=24)


class QuoteRequest(BaseModel):
    proposal_id: str | None = Field(default=None, max_length=40)
    option_id: str | None = Field(default=None, max_length=60)
    lines: list[QuoteLine] | None = Field(default=None, max_length=20)
    pickup_slot_id: str | None = Field(default=None, max_length=40)
    intent_id: str | None = Field(default=None, max_length=40)
    merchant: str | None = Field(default=None, max_length=80)  # shop slug for basket lines; one shop per basket


@router.post("/quotes")
def create_quote(req: QuoteRequest, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    """Server-side quote: prices and totals always come from the database, never from the request."""
    if req.proposal_id and req.option_id:
        return quotes.create_from_option(session_id, req.proposal_id, req.option_id, req.pickup_slot_id)
    if req.lines and req.pickup_slot_id and req.merchant:
        return quotes.create_from_lines(session_id, [(line.sku, line.qty) for line in req.lines], req.pickup_slot_id, req.intent_id, req.merchant)
    raise Unprocessable("Send a proposal option, or basket lines with a shop and pickup slot", code="quote_request_invalid")


@router.get("/quotes/{quote_id}")
def get_quote(quote_id: str, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    return quotes.status_view(session_id, quote_id)


@router.post("/quotes/{quote_id}/refresh")
def refresh_quote(quote_id: str, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    return quotes.refresh(session_id, quote_id)


class SlotChange(BaseModel):
    pickup_slot_id: str = Field(max_length=40)


@router.post("/quotes/{quote_id}/slot")
def change_slot(quote_id: str, req: SlotChange, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    return quotes.change_slot(session_id, quote_id, req.pickup_slot_id)


class ReservationRequest(BaseModel):
    quote_id: str = Field(max_length=40)


@router.post("/reservations", dependencies=[Depends(rate_limit("checkout", 60))])
def reserve(req: ReservationRequest, session_id: str = Depends(shopper_session)) -> dict[str, Any]:
    """Atomic inventory hold with a visible expiry."""
    return holds.reserve_for_session(session_id, req.quote_id)
