"""Support reply drafts: an agent that reads the order and, when the customer asks about money, checks with PayPal.

A customer's message gets a plain template draft straight away, so staff always have something to send. A
background job then runs the agent. The order's facts and the shop's policy text come with the request; its one
lookup tool asks PayPal for the live state of the payment (Orders v2 for the order, Payments v2 for the capture
and refunds, as the shop when the shop was paid). The agent drafts a reply that a staff member reviews and sends.
It cannot refund, cancel or change anything, and the amounts it may mention are limited to the ones it was shown.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app import clock
from app.ai import prompts
from app.ai.agent import Tool, ToolError, run_agent
from app.ai.sanitize import clean_customer_prose
from app.config import settings
from app.db import transaction
from app.models import Order, PaymentAttempt, Refund, SupportRequest
from app.money import format_money
from app.payments import get_client
from app.payments.base import PayPalError, PayPalOutcomeUnknown
from app.payments.payee import auth_assertion
from app.services import jobs
from app.services.catalog import merchant_by_id

log = logging.getLogger(__name__)

KIND = "support"
JOB = "support.draft"

CAPTURE_WORDS = {"COMPLETED": "Paid", "PENDING": "Pending", "DECLINED": "Declined", "FAILED": "Failed",
                 "REFUNDED": "Refunded", "PARTIALLY_REFUNDED": "Partly refunded"}
REFUND_WORDS = {"COMPLETED": "Refunded", "PENDING": "On its way", "FAILED": "Failed", "CANCELLED": "Cancelled"}


class CheckArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")


class DraftArgs(BaseModel):
    reply: str = Field(min_length=1, max_length=900)


def queue_draft(db, request_id: str) -> None:
    jobs.enqueue(JOB, {"request_id": request_id}, dedupe_key=f"{JOB}:{request_id}", max_attempts=2, db=db)


@jobs.handler(JOB)
def _draft_job(payload: dict[str, Any]) -> dict[str, Any]:
    return draft(payload["request_id"])


def draft(request_id: str) -> dict[str, Any]:
    """Run the agent for one open message and keep its draft when it produced a usable one."""
    from app.services.orders import customer_view  # noqa: PLC0415 - orders imports this module

    with transaction() as db:
        row = db.get(SupportRequest, request_id)
        if row is None or row.status != "open" or row.ai_run_id:
            return {"skipped": True}
        order = db.get(Order, row.order_id)
        merchant = merchant_by_id(db, order.merchant_id)
        view = customer_view(db, order, merchant, clock.now())
        refunds = db.scalars(select(Refund).where(Refund.order_id == order.id).order_by(Refund.created_at)).all()
        facts = order_facts(order, view, refunds)
        policy = {"cancellation": view["cancellation"]["policy_text"], "refund": view["cancellation"]["refund_policy_text"],
                  "pickup": view["pickup"]["instructions"]}
        message, order_id, tz = row.message, order.id, merchant.timezone

    state: dict[str, Any] = {"order_id": order_id, "timezone": tz, "checks": [], "amounts": {facts["total"], *facts["refunds_amounts"]}}
    result = run_agent(
        kind=KIND, prompt_version=prompts.SUPPORT_AGENT_PROMPT_VERSION, system=prompts.SUPPORT_AGENT_SYSTEM,
        messages=[{"role": "user", "content": json.dumps({"order": facts, "policy": policy, "customer_message": message}, ensure_ascii=False)}],
        tools=_tools(), subject=("support", request_id), state=state, timeout=40, turn_timeout=18, think="low",
    )
    reply = None
    if result.ok and isinstance(result.final, DraftArgs):
        reply = clean_customer_prose(result.final.reply, allowed_amounts=state["amounts"], max_chars=650)
    with transaction() as db:
        row = db.get(SupportRequest, request_id, with_for_update=True)
        if row is None or row.status != "open":
            return {"skipped": True}
        row.ai_run_id = result.run_id
        row.ai_checks = state["checks"] or None
        if reply:
            row.ai_draft, row.ai_draft_source = reply, "agent"
        order = db.get(Order, row.order_id)
        order.updated_at = clock.now()  # the shop's open order view refreshes with the new draft
    return {"run_id": result.run_id, "status": result.status, "drafted": bool(reply), "checked_paypal": bool(state["checks"])}


def order_facts(order: Order, view: dict[str, Any], refunds: list[Refund]) -> dict[str, Any]:
    """What LastCall knows about the order, in the words the reply may use."""
    return {
        "order_number": order.order_number,
        "payment_status": order.payment_status,
        "fulfillment_status": order.fulfillment_status,
        "refund_status": order.refund_status,
        "pickup_window": f"{view['pickup']['date_label']} {view['pickup']['label']}",
        "items": [f"{line['qty']} {line['name']}" for line in view["lines"]],
        "total": format_money(order.amount_minor, order.currency),
        "refunds": [{"amount": format_money(r.amount_minor, r.currency), "state": r.state} for r in refunds],
        "refunds_amounts": [format_money(r.amount_minor, r.currency) for r in refunds],
        "cancellation_allowed": view["cancellation"]["can_request"],
        "cancellation_allowed_until": view["cancellation"]["allowed_until_label"],
    }


# --------------------------------------------------------------------------- the PayPal lookup


def _tools() -> list[Tool]:
    return [
        Tool("check_payment_with_paypal", "Ask PayPal for the live state of this order's payment: the PayPal order, the capture (the charge) "
             "and any refunds, with amounts and times. Use it when the customer asks about a charge, payment or refund.", CheckArgs, _check_paypal),
        Tool("draft_reply", "The reply for staff to review and send. Ends your turn.", DraftArgs, final=True),
    ]


def _check_paypal(ctx, args: CheckArgs) -> dict[str, Any]:
    with transaction() as db:
        attempt = db.scalars(select(PaymentAttempt).where(PaymentAttempt.order_id == ctx.state["order_id"], PaymentAttempt.paypal_order_id.is_not(None))
                             .order_by(PaymentAttempt.created_at.desc()).limit(1)).first()
        refund_ids = [r.paypal_refund_id for r in db.scalars(select(Refund).where(Refund.order_id == ctx.state["order_id"],
                                                                                   Refund.paypal_refund_id.is_not(None))).all()]
        if attempt is None:
            return {"paypal": "No PayPal payment was started for this order."}
        paypal_order_id, capture_id, payee = attempt.paypal_order_id, attempt.capture_id, attempt.payee
    client, tz = get_client(), ctx.state["timezone"]
    assertion = auth_assertion(settings().paypal_client_id or "", payee)  # the shop was paid, so look it up as the shop
    try:
        order = client.get_order(paypal_order_id)
        capture = client.get_capture(capture_id, assertion) if capture_id else None
        refunds = [client.get_refund(rid, assertion) for rid in refund_ids]
    except (PayPalError, PayPalOutcomeUnknown) as exc:
        log.warning("support agent could not reach PayPal", extra={"error": str(exc)[:200]})
        raise ToolError("PayPal couldn't be reached right now. Use the order facts you have and don't state the payment's live state.") from exc

    result: dict[str, Any] = {"paypal_order": {"status": order.get("status")}}
    checks: list[dict[str, str]] = []
    if capture:
        amount = _money(capture.get("amount"))
        reason = (capture.get("status_details") or {}).get("reason")
        result["capture"] = {"status": capture.get("status"), "amount": amount, "pending_reason": reason,
                             "created": _when(capture.get("create_time"), tz), "updated": _when(capture.get("update_time"), tz)}
        word = CAPTURE_WORDS.get(capture.get("status", ""), (capture.get("status") or "").title())
        checks.append({"label": "Payment", "value": " · ".join(x for x in (f"{word}{f' ({reason.lower()})' if reason else ''}", amount,
                                                                             _when(capture.get("create_time"), tz)) if x)})
        ctx.state["amounts"].add(amount)
    else:
        checks.append({"label": "Payment", "value": f"Not charged · PayPal order {(order.get('status') or '').lower()}"})
    result["refunds"] = []
    for refund in refunds:
        amount = _money(refund.get("amount"))
        result["refunds"].append({"status": refund.get("status"), "amount": amount, "created": _when(refund.get("create_time"), tz),
                                  "updated": _when(refund.get("update_time"), tz)})
        word = REFUND_WORDS.get(refund.get("status", ""), (refund.get("status") or "").title())
        checks.append({"label": "Refund", "value": " · ".join(x for x in (word, amount, _when(refund.get("update_time") or refund.get("create_time"), tz)) if x)})
        ctx.state["amounts"].add(amount)
    ctx.state["checks"] = checks
    return result


def _money(amount: dict[str, Any] | None) -> str:
    if not amount:
        return ""
    return format_money(int(Decimal(amount["value"]) * 100), amount["currency_code"])


def _when(iso: str | None, tz: str) -> str:
    if not iso:
        return ""
    local = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZoneInfo(tz))
    return f"{local.strftime('%b %-d')}, {clock.display_time(local, tz)}"
