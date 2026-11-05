"""The merchant console's Today screen, and the platform's PayPal connection check.

No vanity numbers: every counter is computed from inventory rows and orders.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select

from app import clock
from app.db import transaction
from app.models import BundleQuote, Order, SystemState
from app.payments import PayPalNotConfigured, get_client
from app.payments.payee import display as payee_display
from app.services import jobs, pickup
from app.services.access import StaffContext
from app.services.alerts import open_alerts
from app.services.catalog import merchant_by_id
from app.services.fulfillment import order_summary
from app.services.inventory import inventory_rows

PENDING = ("APPROVAL_PENDING", "APPROVED", "CAPTURE_REQUESTED", "OUTCOME_UNKNOWN", "CAPTURE_PENDING")


def today(ctx: StaffContext) -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, ctx.merchant_id)
        now = clock.now()
        rows = inventory_rows(db, merchant, now)
        active = [r for r in rows if r["status"] == "active"]
        day_start = clock.combine_local(clock.local_date(merchant.timezone), "00:00", merchant.timezone)
        orders = db.scalars(select(Order).where(Order.merchant_id == merchant.id, Order.created_at >= day_start - timedelta(days=1))).all()
        paid = [o for o in orders if o.payment_status == "CAPTURED"]
        sold_units = 0
        for o in paid:
            if o.fulfillment_status != "CANCELLED" and o.confirmed_at and o.confirmed_at >= day_start:
                sold_units += sum(line["qty"] for line in db.get(BundleQuote, o.quote_id).item_lines)
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
            "slots": slots,
            "top_surplus": sorted(active, key=lambda r: (-r["available"], r["sku"]))[:5],
            "recent_orders": [order_summary(db, o, merchant, now) for o in sorted(orders, key=lambda o: o.created_at, reverse=True)[:8]],
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
