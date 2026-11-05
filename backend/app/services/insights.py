"""AnalyticsService: merchant insights computed from orders, reservations and events.

Every metric uses the spec's definition and returns its numerator and denominator, so the
UI can show the evidence. "Estimated waste avoided" is deliberately not reported: there is
no defensible baseline. Small samples get an explicit caution, never causal claims.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from statistics import median
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app import clock
from app.db import transaction
from app.ids import new_id
from app.models import AnalyticsEvent, BundleQuote, InventoryEvent, MetricSnapshot, Order, Refund
from app.services import jobs
from app.services.catalog import availability, list_merchants, merchant_by_id

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
        refunds = db.scalars(select(Refund).where(Refund.state == "COMPLETED", Refund.completed_at >= start, Refund.completed_at <= end)).all()
        refunded = sum(r.amount_minor for r in refunds)
        discounts = sum(quotes[o.quote_id].discount_minor for o in captured if o.quote_id in quotes)
        sold_units = sum(sum(line["qty"] for line in quotes[o.quote_id].item_lines) for o in captured
                         if o.quote_id in quotes and o.fulfillment_status != "CANCELLED")
        inv_events = db.scalars(select(InventoryEvent).where(InventoryEvent.merchant_id == merchant.id, InventoryEvent.created_at >= start,
                                                             InventoryEvent.created_at <= end)).all()
        listed = sum(e.delta for e in inv_events if e.event_type in ("LISTED", "RESET") and e.delta > 0) + \
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
