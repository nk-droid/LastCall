"""Structured JSON logs with correlation/trace IDs, PII redaction and in-process metrics."""

from __future__ import annotations

import contextvars
import json
import logging
import re
import sys
import threading
import time
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

correlation_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("correlation_id", default=None)
trace_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("trace_id", default=None)

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)")


def redact(value: str) -> str:
    """Remove contact details from text bound for logs or a model."""
    value = _EMAIL.sub("[email]", value)
    return _PHONE.sub("[phone]", value)


def redact_obj(value: Any) -> Any:
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {k: ("[redacted]" if k in {"email", "phone", "customer_contact", "name"} else redact_obj(v)) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [redact_obj(v) for v in value]
    return value


_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": redact(record.getMessage()),
        }
        cid = correlation_id_var.get()
        if cid:
            payload["correlation_id"] = cid
        tid = trace_id_var.get()
        if tid:
            payload["trace_id"] = tid
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = redact_obj(value)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class PlainFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        cid = correlation_id_var.get()
        prefix = f"[{cid[:8]}] " if cid else ""
        base = f"{record.levelname:<7} {record.name}: {prefix}{redact(record.getMessage())}"
        if record.exc_info:
            base += "\n" + self.formatException(record.exc_info)
        return base


def setup_logging(level: str = "INFO", as_json: bool = True) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if as_json else PlainFormatter())
    root.addHandler(handler)
    root.setLevel(level.upper())
    for noisy in ("httpx", "httpcore", "uvicorn.access", "pgserver"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


# --------------------------------------------------------------------------- metrics


class Metrics:
    """Tiny thread-safe counter/histogram registry rendered in Prometheus text format."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], float] = defaultdict(float)
        self._sums: dict[tuple[str, tuple[tuple[str, str], ...]], tuple[int, float]] = {}

    def inc(self, name: str, value: float = 1, **labels: str) -> None:
        key = (name, tuple(sorted((k, str(v)) for k, v in labels.items())))
        with self._lock:
            self._counters[key] += value

    def observe(self, name: str, seconds: float, **labels: str) -> None:
        key = (name, tuple(sorted((k, str(v)) for k, v in labels.items())))
        with self._lock:
            count, total = self._sums.get(key, (0, 0.0))
            self._sums[key] = (count + 1, total + seconds)

    def render(self) -> str:
        lines: list[str] = []
        with self._lock:
            for (name, labels), value in sorted(self._counters.items()):
                lines.append(f"{name}{_labels(labels)} {value}")
            for (name, labels), (count, total) in sorted(self._sums.items()):
                lines.append(f"{name}_count{_labels(labels)} {count}")
                lines.append(f"{name}_sum{_labels(labels)} {total:.6f}")
        return "\n".join(lines) + "\n"


def _labels(labels: tuple[tuple[str, str], ...]) -> str:
    if not labels:
        return ""
    inner = ",".join(f'{k}="{v}"' for k, v in labels)
    return "{" + inner + "}"


metrics = Metrics()


class Timer:
    def __enter__(self) -> Timer:
        self.start = time.perf_counter()
        return self

    def __exit__(self, *exc: object) -> None:
        self.elapsed = time.perf_counter() - self.start

    @property
    def ms(self) -> int:
        return int(getattr(self, "elapsed", time.perf_counter() - self.start) * 1000)
