"""Customer emails about an order: confirmation (with the pickup code), ready for pickup, refund completed.

Sent only when the shopper gave an email. Each links to the order page with the order's private
link token, so it opens on any device. Amounts and statuses come from the database, never a model.
"""

from __future__ import annotations

from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app import clock
from app.models import BundleQuote, Merchant, Order, Refund
from app.money import format_money
from app.security import order_link_token, pickup_code
from app.services import mail
from app.services.catalog import address_line


def _email(order: Order) -> str | None:
    return (order.customer_contact or {}).get("email")


def _link(order: Order) -> str:
    return mail.app_link(f"/orders/{order.id}?t={order_link_token(order.id)}")


def _context(db: Session, order: Order, merchant: Merchant) -> dict[str, Any]:
    quote = db.get(BundleQuote, order.quote_id)
    tz = merchant.timezone
    return {
        "name": (order.customer_contact or {}).get("name", ""), "shop": merchant.name, "order_number": order.order_number,
        "total": format_money(order.amount_minor, order.currency), "address": address_line(merchant),
        "pickup": f"{order.pickup_starts_at.astimezone(ZoneInfo(tz)).strftime('%a, %b %-d')}, "
                  f"{clock.display_time(order.pickup_starts_at, tz)}–{clock.display_time(order.pickup_ends_at, tz)}",
        "items": [f"{line['qty']} × {line['name']}" for line in (quote.item_lines if quote else [])],
    }


def order_confirmed(db: Session, order: Order, merchant: Merchant) -> bool:
    to = _email(order)
    if not to:
        return False
    ctx = {**_context(db, order, merchant), "code": pickup_code(order.id, order.pickup_code_salt)}
    mail.queue(db, to=to, template="order_confirmed", context={k: v for k, v in ctx.items() if k != "code"}, link=_link(order),
               secret={"code": ctx["code"]})
    return True


def order_ready(db: Session, order: Order, merchant: Merchant) -> bool:
    to = _email(order)
    if not to:
        return False
    mail.queue(db, to=to, template="order_ready", context=_context(db, order, merchant), link=_link(order))
    return True


def refund_completed(db: Session, order: Order, refund: Refund, merchant: Merchant) -> bool:
    to = _email(order)
    if not to:
        return False
    ctx = {**_context(db, order, merchant), "refund": format_money(refund.amount_minor, refund.currency)}
    mail.queue(db, to=to, template="refund_completed", context=ctx, link=_link(order))
    return True
