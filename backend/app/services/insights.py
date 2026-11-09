"""AnalyticsService: merchant insights computed from orders, reservations and events.

Every metric uses the spec's definition and returns its numerator and denominator, so the
UI can show the evidence. "Estimated waste avoided" is deliberately not reported: there is
no defensible baseline. Small samples get an explicit caution, never causal claims.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, datetime, timedelta
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import clock
from app.db import transaction
from app.ids import new_id
from app.models import AnalyticsEvent, BundleQuote, InventoryEvent, Merchant, MetricSnapshot, Order, PickupSlot, Product, Refund
from app.services import assistant, jobs
from app.services.catalog import availability, current_prices, image_view, list_merchants, merchant_by_id

FUNNEL = ["intent_submitted", "bundle_proposed", "bundle_viewed", "quote_created", "reservation_created", "paypal_approved", "capture_verified", "pickup_completed"]


def _ratio(num: float, den: float) -> dict[str, Any]:
    return {"numerator": num, "denominator": den, "value": round(num / den, 4) if den else None}


def period_bounds(merchant_tz: str, period: str) -> tuple[datetime, datetime]:
    end = clock.now()
    today_start = clock.combine_local(clock.local_date(merchant_tz), "00:00", merchant_tz)
    if period == "7d":
        return today_start - timedelta(days=6), end
    return today_start, end


def compute(merchant_id: str, period: str = "today") -> dict[str, Any]:
    with transaction() as db:
        merchant = merchant_by_id(db, merchant_id)
        start, end = period_bounds(merchant.timezone, period)
        events = db.scalars(select(AnalyticsEvent).where(AnalyticsEvent.merchant_id == merchant.id, AnalyticsEvent.created_at >= start,
                                                         AnalyticsEvent.created_at <= end)).all()
        by_name: dict[str, list[AnalyticsEvent]] = defaultdict(list)
        for e in events:
            by_name[e.event_name].append(e)

        def sessions(name: str) -> set[str]:
            return {e.session_id for e in by_name[name] if e.session_id}

        viewed_sessions = sessions("bundle_viewed") or sessions("bundle_proposed")
        accepted_sessions = sessions("bundle_accepted")

        orders = db.scalars(select(Order).where(Order.merchant_id == merchant.id, Order.created_at >= start, Order.created_at <= end)).all()
        captured = [o for o in orders if o.payment_status == "CAPTURED"]
        quotes = {q.id: q for q in db.scalars(select(BundleQuote).where(BundleQuote.id.in_([o.quote_id for o in orders] or [""]))).all()}
        gross = sum(o.amount_minor for o in captured)
        # Refunds belong to the shop through their order; without the join every shop's refunds were counted.
        refunds = db.scalars(select(Refund).join(Order, Order.id == Refund.order_id).where(
            Order.merchant_id == merchant.id, Refund.state == "COMPLETED", Refund.completed_at >= start, Refund.completed_at <= end)).all()
        refunded = sum(r.amount_minor for r in refunds)
        discounts = sum(quotes[o.quote_id].discount_minor for o in captured if o.quote_id in quotes)
        sold_units = sum(sum(line["qty"] for line in quotes[o.quote_id].item_lines) for o in captured
                         if o.quote_id in quotes and o.fulfillment_status != "CANCELLED")
        inv_events = db.scalars(select(InventoryEvent).where(InventoryEvent.merchant_id == merchant.id, InventoryEvent.created_at >= start,
                                                             InventoryEvent.created_at <= end)).all()
        listed = sum(e.delta for e in inv_events if e.event_type in ("LISTED", "RESET", "RELISTED") and e.delta > 0) + \
            sum(e.delta for e in inv_events if e.event_type == "ADJUSTED" and e.delta > 0)
        now = clock.now()
        avail = availability(db, merchant.id, now)
        remaining = sum(a.available + a.reserved for a in avail.values())
        eligible_pickup = [o for o in captured if o.fulfillment_status != "CANCELLED" and (o.fulfillment_status == "PICKED_UP" or o.pickup_ends_at <= now)]
        picked = [o for o in captured if o.fulfillment_status == "PICKED_UP"]
        durations = [(o.picked_up_at - o.confirmed_at).total_seconds() / 60 for o in picked if o.picked_up_at and o.confirmed_at]
        expired = [e for e in by_name["reservation_expired"]]
        funnel = []
        for step in FUNNEL:
            funnel.append({"step": step, "sessions": len(sessions(step)), "events": len(by_name[step])})
        sample = len(sessions("intent_submitted"))
        return {
            "period": period,
            "period_start": clock.iso(start),
            "period_end": clock.iso(end),
            "currency": merchant.currency,
            "metrics": {
                "bundle_acceptance": {**_ratio(len(accepted_sessions & viewed_sessions) or len(accepted_sessions), len(viewed_sessions)),
                                      "definition": "Sessions that chose a proposed bundle / sessions shown proposals"},
                "checkout_completion": {**_ratio(len(by_name["capture_verified"]), len(by_name["checkout_started"])),
                                        "definition": "Verified captured orders / checkout sessions initiated"},
                "substitution_acceptance": {**_ratio(len(by_name["substitution_accepted"]), len(by_name["substitution_offered"])),
                                            "definition": "Accepted replacement proposals / replacement proposals shown"},
                "surplus_sell_through": {**_ratio(sold_units, listed), "definition": "Surplus units sold / surplus units listed in the period"},
                "reservation_loss": {**_ratio(len(expired), len(by_name["reservation_created"])),
                                     "definition": "Reservations expired or abandoned without capture / reservations created"},
                "inventory_mismatch": {"value": len(by_name["reservation_rejected_stock"]),
                                       "definition": "Reservation attempts rejected because current stock was insufficient"},
                "pickup_success": {**_ratio(len(picked), len(eligible_pickup)), "definition": "Orders handed off / paid orders eligible for pickup"},
                "stockout_frequency": {"value": len(by_name["stockout"]), "definition": "Times an item's available-to-sell reached zero"},
                "median_time_to_pickup_minutes": {"value": round(median(durations), 1) if durations else None,
                                                  "definition": "Median minutes from verified payment to handoff"},
            },
            "money": {
                "gross_merchandise_value_minor": gross,
                "gmv_label": "Gross (captured, before refunds)",
                "refunded_minor": refunded,
                "net_captured_sales_minor": gross - refunded,
                "discounts_given_minor": discounts,
                "completed_captures": len(captured),
            },
            "units": {"listed": listed, "sold": sold_units, "remaining": remaining},
            "funnel": funnel,
            "waste_avoided": {"reported": False, "reason": "Not reported: there is no defensible baseline for what would have been thrown away."},
            "caution": f"Based on {sample} shopper session{'s' if sample != 1 else ''}. Treat these as observations, not evidence of cause and effect." if sample < 30 else None,
            "computed_at": clock.iso(clock.now()),
        }


def snapshot(merchant_id: str, period: str = "today") -> dict[str, Any]:
    data = compute(merchant_id, period)
    with transaction() as db:
        merchant = merchant_by_id(db, merchant_id)
        values = dict(period_end=datetime.fromisoformat(data["period_end"].replace("Z", "+00:00")), metrics=data, computed_at=clock.now())
        db.execute(insert(MetricSnapshot).values(id=new_id("met"), merchant_id=merchant.id, period=period,
                                                 period_start=datetime.fromisoformat(data["period_start"].replace("Z", "+00:00")), **values)
                   .on_conflict_do_update(constraint="uq_metric_snapshot_period", set_=values))
    return {"computed_at": data["computed_at"]}


def snapshot_all(period: str = "today") -> dict[str, Any]:
    """Background aggregate for every merchant."""
    with transaction() as db:
        ids = [m.id for m in list_merchants(db)]
    return {"merchants": [snapshot(merchant_id, period)["computed_at"] for merchant_id in ids]}


def latest(merchant_id: str, period: str = "today") -> dict[str, Any]:
    """Live metrics plus when the background aggregate last ran (snapshots are kept as history)."""
    data = compute(merchant_id, period)
    with transaction() as db:
        merchant = merchant_by_id(db, merchant_id)
        row = db.scalar(select(MetricSnapshot).where(MetricSnapshot.merchant_id == merchant.id, MetricSnapshot.period == period)
                        .order_by(MetricSnapshot.computed_at.desc()).limit(1))
        data["last_snapshot_at"] = clock.iso(row.computed_at) if row else None
    return data


@jobs.handler("analytics.aggregate", every=300)
def _aggregate(_: dict[str, Any]) -> dict[str, Any]:
    return snapshot_all("today")


# --------------------------------------------------------------------------- the owner's summary

SUMMARY_PERIODS = {"7d": 7, "30d": 30}
MIN_DAYS = 3           # fewer days of an item's history than this and we don't suggest anything
SOLD_OUT_SHARE = 0.7   # sold out on most days: list more
LEFT_SHARE = 0.5       # left over on at least half the closed days: list fewer
BUSY_HOURS = 3         # the busiest stretch of the day, in hours
MIN_ORDERS_FOR_HOURS = 8
RULE = "Sold out on most days: list more. Left over on at least half the closed days: list fewer."


def _paid_orders(db: Session, merchant_id: str, start: datetime, end: datetime) -> list[Order]:
    return list(db.scalars(select(Order).where(Order.merchant_id == merchant_id, Order.payment_status == "CAPTURED",
                                               Order.created_at >= start, Order.created_at <= end)).all())


def _refunded(db: Session, merchant_id: str, start: datetime, end: datetime) -> int:
    return db.scalar(select(func.coalesce(func.sum(Refund.amount_minor), 0)).join(Order, Order.id == Refund.order_id).where(
        Order.merchant_id == merchant_id, Refund.state == "COMPLETED", Refund.completed_at >= start, Refund.completed_at <= end)) or 0


def _left_at_close(db: Session, merchant: Merchant, products: dict[str, Product], first: date, last: date) -> dict[str, dict[str, int]]:
    """Units still unsold when each day from ``first`` to ``last`` closed, per repeat-daily product.

    Read from the next morning's daily relist: it sets surplus to the relist quantity plus whatever is held, so
    what was unsold just before it is ``before - (after - relist_qty)``. The first relist of a morning stands for
    the previous day's close.
    """
    tz = merchant.timezone
    zone = ZoneInfo(tz)
    events = db.scalars(select(InventoryEvent).where(
        InventoryEvent.merchant_id == merchant.id, InventoryEvent.event_type == "RELISTED",
        InventoryEvent.created_at >= clock.combine_local(first + timedelta(days=1), "00:00", tz),
        InventoryEvent.created_at < clock.combine_local(last + timedelta(days=2), "00:00", tz)).order_by(InventoryEvent.created_at)).all()
    seen: set[tuple[str, date]] = set()
    out: dict[str, dict[str, int]] = defaultdict(lambda: {"left": 0, "days_left": 0, "closed_days": 0})
    for e in events:
        key = (e.product_id, e.created_at.astimezone(zone).date())
        product = products.get(e.product_id)
        if key in seen or product is None:
            continue
        seen.add(key)
        left = max(0, e.surplus_before - max(0, e.surplus_after - product.relist_qty))
        row = out[e.product_id]
        row["left"] += left
        row["days_left"] += 1 if left else 0
        row["closed_days"] += 1
    return out


def _suggestion(product: Product, sold: int, sold_out_days: int, data_days: int, left: dict[str, int]) -> dict[str, str]:
    if data_days < MIN_DAYS:
        return {"kind": "early", "label": "Too early to tell"}
    unit = " a day" if product.relist_daily else ""
    if sold_out_days >= max(2, math.ceil(data_days * SOLD_OUT_SHARE)):
        return {"kind": "more", "label": f"List {max(1, round(sold / data_days * 0.25))} more{unit}"}
    closed = left["closed_days"]
    if closed and left["days_left"] >= max(2, math.ceil(closed * LEFT_SHARE)):
        # Halfway to what was left, so the shop can adjust again next week instead of overshooting.
        return {"kind": "fewer", "label": f"List {max(1, round(left['left'] / closed / 2))} fewer{unit}"}
    return {"kind": "keep", "label": "Keep as is"}


def _hour_label(hour: int) -> str:
    return f"{hour % 12 or 12} {'AM' if hour % 24 < 12 else 'PM'}"


def summary(merchant_id: str, period: str = "7d") -> dict[str, Any]:
    """What an owner asks of a week or a month: sales and how they compare, how much of the menu price came back,
    what was left at close, when shoppers buy, what to list tomorrow, and what shoppers wanted but couldn't get.

    The comparison window is the same length, shifted back, and cut at the same time of day so a half-finished
    today is compared with a half-finished day.
    """
    days = SUMMARY_PERIODS[period]
    with transaction() as db:
        merchant = merchant_by_id(db, merchant_id)
        tz = merchant.timezone
        zone = ZoneInfo(tz)
        now = clock.now()
        today = clock.local_date(tz)
        first = today - timedelta(days=days - 1)
        start = clock.combine_local(first, "00:00", tz)
        span = timedelta(days=days)

        orders = _paid_orders(db, merchant.id, start, now)
        prev_orders = _paid_orders(db, merchant.id, start - span, now - span)
        refunded = _refunded(db, merchant.id, start, now)
        prev_refunded = _refunded(db, merchant.id, start - span, now - span)
        gross = sum(o.amount_minor for o in orders)
        net = gross - refunded
        prev_net = sum(o.amount_minor for o in prev_orders) - prev_refunded

        kept = [o for o in orders if o.fulfillment_status != "CANCELLED"]
        quotes = {q.id: q for q in db.scalars(select(BundleQuote).where(BundleQuote.id.in_([o.quote_id for o in kept] or [""]))).all()}
        menu_value = sum(q.subtotal_reference_minor for q in quotes.values())
        saved = sum(q.discount_minor for q in quotes.values())
        sold: dict[str, int] = defaultdict(int)
        sale_days: dict[str, set[date]] = defaultdict(set)
        for o in kept:
            q = quotes.get(o.quote_id)
            for line in q.item_lines if q else []:
                sold[line["product_id"]] += int(line["qty"])
                sale_days[line["product_id"]].add(o.created_at.astimezone(zone).date())

        products = {p.id: p for p in db.scalars(select(Product).where(Product.merchant_id == merchant.id)).all()}
        inv = db.scalars(select(InventoryEvent).where(InventoryEvent.merchant_id == merchant.id, InventoryEvent.created_at >= start,
                                                      InventoryEvent.created_at <= now)).all()
        # Listed = each morning's daily relist (its quantity, however much was already on the shelf) plus anything
        # staff added by hand. A relist's own delta can't be used: it is zero when nothing sold the day before.
        listed: dict[str, int] = defaultdict(int)
        stock_days: dict[str, set[date]] = defaultdict(set)
        relisted: set[tuple[str, date]] = set()
        for e in inv:
            day = e.created_at.astimezone(zone).date()
            stock_days[e.product_id].add(day)
            if e.event_type == "RELISTED" and e.product_id in products:
                if (e.product_id, day) not in relisted:
                    relisted.add((e.product_id, day))
                    listed[e.product_id] += products[e.product_id].relist_qty
            elif e.event_type in ("LISTED", "RESET", "ADJUSTED") and e.delta > 0:
                listed[e.product_id] += e.delta
        stockouts = db.scalars(select(AnalyticsEvent).where(AnalyticsEvent.merchant_id == merchant.id, AnalyticsEvent.event_name == "stockout",
                                                            AnalyticsEvent.entity_type == "product", AnalyticsEvent.created_at >= start,
                                                            AnalyticsEvent.created_at <= now).order_by(AnalyticsEvent.created_at)).all()
        first_out: dict[str, dict[date, datetime]] = defaultdict(dict)
        for e in stockouts:
            local = e.created_at.astimezone(zone)
            first_out[e.entity_id].setdefault(local.date(), local)

        # Closed days only: today hasn't closed yet.
        left = _left_at_close(db, merchant, products, first, today - timedelta(days=1)) if days > 1 else {}
        prev_left = _left_at_close(db, merchant, products, first - span, today - timedelta(days=1) - span)
        prices = current_prices(db, list(products), now)

        items = []
        for pid, p in products.items():
            if p.status != "active" and not sold.get(pid):
                continue
            outs = first_out.get(pid, {})
            data_days = len(stock_days[pid] | sale_days[pid] | set(outs))
            row_left = left.get(pid, {"left": 0, "days_left": 0, "closed_days": 0})
            minutes = [t.hour * 60 + t.minute for t in outs.values()]
            by = None
            if minutes:
                m = int(median(minutes))
                by = clock.display_time(datetime.combine(today, datetime.min.time(), zone) + timedelta(minutes=m), tz)
            items.append({
                "product_id": pid, "name": p.name, "image": image_view(p), "category": p.category, "relist_daily": p.relist_daily,
                "sold": sold.get(pid, 0), "listed": max(listed.get(pid, 0), sold.get(pid, 0)),
                "left": row_left["left"] if p.relist_daily else None, "left_days": row_left["days_left"],
                "sold_out_days": len(outs), "sold_out_by": by, "days": data_days,
                "suggestion": _suggestion(p, sold.get(pid, 0), len(outs), data_days, row_left),
            })
        order_rank = {"more": 0, "fewer": 1, "keep": 2, "early": 3}
        items.sort(key=lambda i: (order_rank[i["suggestion"]["kind"]], -i["sold_out_days"], -(i["left"] or 0), -i["sold"], i["name"]))

        day_rows = []
        for n in range(days):
            day = first + timedelta(days=n)
            todays = [o for o in orders if o.created_at.astimezone(zone).date() == day]
            day_rows.append({"date": day.isoformat(), "sales_minor": sum(o.amount_minor for o in todays), "orders": len(todays), "today": day == today})

        hours = [0] * 24
        for o in orders:
            hours[o.created_at.astimezone(zone).hour] += 1
        busiest = None
        if len(orders) >= MIN_ORDERS_FOR_HOURS:
            h = max(range(24 - BUSY_HOURS + 1), key=lambda i: sum(hours[i:i + BUSY_HOURS]))
            count = sum(hours[h:h + BUSY_HOURS])
            busiest = {"start": h, "end": h + BUSY_HOURS, "label": f"{_hour_label(h)}–{_hour_label(h + BUSY_HOURS)}",
                       "share": round(count / len(orders), 3)}

        slots = db.scalars(select(PickupSlot).where(PickupSlot.merchant_id == merchant.id, PickupSlot.starts_at >= start,
                                                    PickupSlot.ends_at <= now, PickupSlot.capacity > 0)).all()
        if busiest:
            slots = [s for s in slots if busiest["start"] <= s.starts_at.astimezone(zone).hour < busiest["end"]]
        capacity = sum(s.capacity for s in slots)
        picked = [o for o in kept if o.fulfillment_status == "PICKED_UP" and o.picked_up_at and o.confirmed_at]
        waits = [(o.picked_up_at - o.confirmed_at).total_seconds() / 60 for o in picked]

        left_units = sum(r["left"] for pid, r in left.items() if products[pid].relist_daily)
        left_value = sum(r["left"] * (prices[pid].reference_minor if pid in prices else 0) for pid, r in left.items())
        relisting = any(p.relist_daily and p.status == "active" for p in products.values())
        total_sold = sum(sold.values())
        total_listed = sum(i["listed"] for i in items)

        return {
            "period": period,
            "days": days,
            "start": first.isoformat(),
            "end": today.isoformat(),
            "compare_start": (first - span).isoformat(),
            "compare_end": (today - span).isoformat(),
            "currency": merchant.currency,
            "headline": {
                "net_sales_minor": net,
                "prev_net_sales_minor": prev_net,
                "prev_daily_average_minor": sum(o.amount_minor for o in prev_orders) // days,
                "change": round((net - prev_net) / prev_net, 3) if prev_net > 0 else None,
                "orders": len(orders),
                "average_order_minor": gross // len(orders) if orders else 0,
                "refunded_minor": refunded,
                "menu_value_minor": menu_value,
                "paid_value_minor": menu_value - saved,
                "saved_minor": saved,
                "recovered": round((menu_value - saved) / menu_value, 3) if menu_value else None,
                "sold_units": total_sold,
                "listed_units": total_listed,
                "left_at_close": {
                    "units": left_units,
                    "menu_value_minor": left_value,
                    "prev_units": sum(r["left"] for pid, r in prev_left.items() if products[pid].relist_daily),
                    "closed_days": max((r["closed_days"] for r in left.values()), default=0),
                } if relisting else None,
            },
            "sales_by_day": day_rows,
            "orders_by_hour": hours,
            "busiest": busiest,
            "pickup": {
                "slot_fill": round(sum(s.booked_count for s in slots) / capacity, 3) if capacity else None,
                "slot_fill_label": busiest["label"] if busiest else None,
                "no_shows": sum(1 for o in orders if o.pickup_expired_at is not None),
                "median_wait_minutes": round(median(waits)) if waits else None,
            },
            "items": items,
            "rule": RULE,
            "missed": assistant.missed_demand(db, merchant.id, start, now),
            "caution": f"Based on {len(orders)} order{'s' if len(orders) != 1 else ''}. Patterns firm up after a couple of weeks."
            if len(orders) < 30 else None,
            "computed_at": clock.iso(now),
        }
