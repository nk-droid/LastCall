"""The merchant console's Today screen, and the platform's PayPal connection check.

No vanity numbers: every counter is computed from inventory rows and orders.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select

from app import clock
from app.db import transaction
from app.models import BundleQuote, Order, Reservation, SystemState
from app.payments import PayPalNotConfigured, get_client
from app.payments.payee import display as payee_display
from app.services import jobs, pickup
from app.services.access import StaffContext
from app.services.alerts import open_alerts
from app.services.catalog import merchant_by_id
from app.services.fulfillment import order_lines, order_summary
from app.services.inventory import inventory_rows

PENDING = ("APPROVAL_PENDING", "APPROVED", "CAPTURE_REQUESTED", "OUTCOME_UNKNOWN", "CAPTURE_PENDING")
# In checkout: the hold is placed and the shopper is paying. Shown in the pickup queue as "Paying".
PAYING = ("RESERVED", *PENDING)


def today(ctx: StaffContext) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, ctx.merchant_id)
        now = clock.now()
        rows = inventory_rows(db, merchant, now)
        active = [r for r in rows if r["status"] == "active"]
        day_start = clock.combine_local(clock.local_date(merchant.timezone), "00:00", merchant.timezone)
        orders = db.scalars(select(Order).where(Order.merchant_id == merchant.id, Order.created_at >= day_start - timedelta(days=1))).all()
        paid = [o for o in orders if o.payment_status == "CAPTURED"]
        sold_by_sku: dict[str, int] = {}
        sales_minor = paid_today = 0
        for o in paid:
            if o.fulfillment_status != "CANCELLED" and o.confirmed_at and o.confirmed_at >= day_start:
                for line in db.get(BundleQuote, o.quote_id).item_lines:
                    sold_by_sku[line["sku"]] = sold_by_sku.get(line["sku"], 0) + line["qty"]
                sales_minor += o.amount_minor
                paid_today += 1
        sold_units = sum(sold_by_sku.values())
        # The pickup queue: paid orders not yet handed off, plus checkouts still paying (their units are on hold).
        waiting = [o for o in orders if (o.payment_status == "CAPTURED" and o.fulfillment_status in ("NEW", "PACKING", "READY"))
                   or o.payment_status in PAYING]
        open_orders = []
        for o in sorted(waiting, key=lambda o: (o.pickup_starts_at, o.created_at)):
            hold = db.get(Reservation, o.reservation_id) if o.payment_status != "CAPTURED" and o.reservation_id else None
            held = bool(hold and hold.state == "HELD" and hold.expires_at > now)
            if o.payment_status != "CAPTURED" and not (held or (hold and hold.state == "PAYMENT_IN_FLIGHT")):
                continue  # the checkout's hold is gone: nothing is waiting on it
            open_orders.append({**order_summary(db, o, merchant, now), "lines": order_lines(db, o),
                                "hold_expires_at": clock.iso(hold.expires_at) if held else None})
        today_local = clock.local_date(merchant.timezone).isoformat()
        slots = [s for s in (pickup.slot_view(s, merchant, now) for s in pickup.list_slots(db, merchant, day_start)) if s["date_local"] == today_local]
        connection = db.get(SystemState, "paypal_connection")
        return {
            "as_of": clock.iso(now),
            "shop": {"name": merchant.name, "status": merchant.status, "timezone": merchant.timezone, "pickup_paused": merchant.pickup_paused},
            "counters": {
                "surplus_units": sum(r["surplus"] for r in active),
                "available_units": sum(r["available"] for r in active),
                "reserved_units": sum(r["reserved"] for r in active),
                "committed_units": sum(r["committed"] for r in active),
                "sold_units_today": sold_units,
            },
            "orders": {
                "awaiting_pickup": sum(1 for o in paid if o.fulfillment_status in ("NEW", "PACKING", "READY")),
                "ready": sum(1 for o in paid if o.fulfillment_status == "READY"),
                "payment_pending": sum(1 for o in orders if o.payment_status in PENDING),
                "picked_up_today": sum(1 for o in paid if o.fulfillment_status == "PICKED_UP" and o.picked_up_at and o.picked_up_at >= day_start),
            },
            "sales": {"amount_minor": sales_minor, "currency": merchant.currency, "paid_orders": paid_today},
            "slots": slots,
            "open_orders": open_orders,
            "stock": [{**r, "sold_today": sold_by_sku.get(r["sku"], 0)} for r in active],
            "alerts": open_alerts(db, merchant.id),
            "stale_inventory": [{"sku": r["sku"], "name": r["name"], "updated_at": r["updated_at"]} for r in active if r["stale"]],
            "paypal": {"payouts": payee_display(merchant.paypal or {}),
                       "reachable": (connection.value.get("ok") if connection else None),
                       "checked_at": (connection.value.get("checked_at") if connection else None)},
        }


def check_paypal_connection() -> dict[str, Any]:
    try:
        result = get_client().check_connection()
    except PayPalNotConfigured as exc:
        result = {"ok": False, "error": exc.message}
    result["checked_at"] = clock.iso(clock.now())
    with transaction() as db:
        row = db.get(SystemState, "paypal_connection", with_for_update=True)
        if row is None:
            db.add(SystemState(key="paypal_connection", value=result))
        else:
            row.value = result
    return result


@jobs.handler("paypal.check", every=1800)
def _check(_: dict[str, Any]) -> dict[str, Any]:
    return check_paypal_connection()
