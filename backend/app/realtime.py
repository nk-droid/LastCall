"""Live updates: PostgreSQL LISTEN/NOTIFY fanned out to server-sent-event subscribers.

Publishing is automatic. After every ORM flush, changed orders, stock lots and holds emit a small
NOTIFY (delivered only if the transaction commits), so no service has to remember to announce
anything and every API instance sees every change. One listener thread per process receives
them and hands each event to the subscribers of its topic:

* ``order:<id>``            an order's payment, fulfillment or refund state changed
* ``shop:<id>:orders``      something changed in a shop's order queue
* ``shop:<id>:stock``       a shop's availability changed (stock edit, hold, sale, re-list)

Events carry only the topic; clients re-fetch through the normal, authorized endpoints.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Any

import psycopg
from sqlalchemy import event, text
from sqlalchemy.orm import Session

from app.models import InventoryLot, Order, Reservation

log = logging.getLogger(__name__)
CHANNEL = "lastcall_events"


# --------------------------------------------------------------------------- publishing


def _topics_for_flush(session: Session) -> tuple[set[str], set[str]]:
    topics: set[str] = set()
    product_ids: set[str] = set()
    for obj in list(session.new) + list(session.dirty):
        if isinstance(obj, Order):
            topics.update({f"order:{obj.id}", f"shop:{obj.merchant_id}:orders"})
        elif isinstance(obj, Reservation):
            topics.add(f"shop:{obj.merchant_id}:stock")
        elif isinstance(obj, InventoryLot):
            product_ids.add(obj.product_id)
    return topics, product_ids


def _after_flush(session: Session, _flush_context: Any) -> None:
    topics, product_ids = _topics_for_flush(session)
    if not topics and not product_ids:
        return
    conn = session.connection()
    for topic in topics:
        conn.execute(text("SELECT pg_notify(:channel, :payload)"), {"channel": CHANNEL, "payload": json.dumps({"topic": topic})})
    if product_ids:
        conn.execute(
            text("SELECT pg_notify(:channel, json_build_object('topic', :prefix || merchant_id || :suffix)::text) "
                 "FROM (SELECT DISTINCT merchant_id FROM products WHERE id = ANY(:ids)) AS shops"),
            {"channel": CHANNEL, "prefix": "shop:", "suffix": ":stock", "ids": list(product_ids)},
        )


_installed = False


def install() -> None:
    global _installed
    if not _installed:
        event.listen(Session, "after_flush", _after_flush)
        _installed = True


# --------------------------------------------------------------------------- subscribing


class Broker:
    """Per-process fan-out from one LISTEN connection to many asyncio subscribers."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: dict[str, set[tuple[asyncio.AbstractEventLoop, asyncio.Queue[str]]]] = {}
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._dsn: str | None = None

    def configure(self, dsn: str) -> None:
        self._dsn = dsn

    def subscribe(self, topics: list[str]) -> tuple[asyncio.Queue[str], Any]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
        entry = (loop, queue)
        with self._lock:
            for topic in topics:
                self._subs.setdefault(topic, set()).add(entry)
            self._ensure_listener()

        def unsubscribe() -> None:
            with self._lock:
                for topic in topics:
                    self._subs.get(topic, set()).discard(entry)
                    if not self._subs.get(topic):
                        self._subs.pop(topic, None)

        return queue, unsubscribe

    def dispatch(self, topic: str) -> None:
        with self._lock:
            targets = list(self._subs.get(topic, ()))
        for loop, queue in targets:
            loop.call_soon_threadsafe(_offer, queue, topic)

    def _ensure_listener(self) -> None:
        if self._thread and self._thread.is_alive() or not self._dsn:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._listen, name="lastcall-realtime", daemon=True)
        self._thread.start()

    def _listen(self) -> None:
        while not self._stop.is_set():
            try:
                with psycopg.connect(self._dsn, autocommit=True) as conn:
                    conn.execute(f"LISTEN {CHANNEL}")
                    while not self._stop.is_set():
                        for note in conn.notifies(timeout=2.0):
                            try:
                                self.dispatch(json.loads(note.payload)["topic"])
                            except (ValueError, KeyError):
                                continue
            except psycopg.Error:
                log.warning("realtime listener lost its connection; reconnecting", exc_info=True)
                self._stop.wait(2.0)

    def stop(self) -> None:
        self._stop.set()


def _offer(queue: asyncio.Queue[str], topic: str) -> None:
    try:
        queue.put_nowait(topic)
    except asyncio.QueueFull:
        pass  # a slow client will re-fetch on its next event anyway


broker = Broker()
