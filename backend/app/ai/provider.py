"""Provider-agnostic structured-output client.

Every call: renders a versioned prompt, asks the provider for JSON, extracts and validates it
against a Pydantic schema (one repair round-trip on schema failure), runs task-specific
semantic validation, and records an AIInvocation row (prompt version, model, latency,
validity, tokens, failure reason). Inputs are hashed, never stored, and contact details are
redacted before anything is sent. Callers always have a deterministic fallback.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_ollama import ChatOllama
from ollama import ResponseError
from pydantic import BaseModel, ValidationError

from app.config import settings
from app.db import transaction
from app.ids import new_id, sha256_hex
from app.models import AIInvocation
from app.observability import metrics, redact_obj

log = logging.getLogger(__name__)


class ProviderFailure(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind  # timeout | unavailable | http_error | refusal


@dataclass
class Completion:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None


class LLMProvider(Protocol):
    name: str
    model: str

    def complete(self, messages: list[dict[str, str]], schema: dict[str, Any], timeout: float, task: str) -> Completion: ...


class OllamaProvider:
    """Ollama chat through LangChain's ChatOllama. By default this is Ollama's cloud API (https://ollama.com,
    authenticated with an API key); a local daemon, which proxies cloud models, needs no key.

    The cloud model does not enforce ``format`` schemas, so the schema is also embedded in
    the system prompt and the reply is validated here regardless.
    """

    name = "langchain-ollama"

    def __init__(self, host: str, model: str, think: str, api_key: str | None = None,
                 client_kwargs: dict[str, Any] | None = None):
        self.host = host.rstrip("/")
        self.model = model
        self.think = think
        self._api_key = api_key
        self._client_kwargs = client_kwargs or {}  # extra httpx client options (e.g. a proxy or a test transport)
        self._chats: dict[float, ChatOllama] = {}
        self._lock = threading.Lock()

    def _chat(self, timeout: float) -> ChatOllama:
        with self._lock:
            if timeout not in self._chats:
                headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
                self._chats[timeout] = ChatOllama(
                    model=self.model,
                    base_url=self.host,
                    temperature=0,
                    reasoning=self.think if "gpt-oss" in self.model else None,
                    client_kwargs={**self._client_kwargs, "headers": headers, "timeout": httpx.Timeout(timeout, connect=5.0)},
                )
            return self._chats[timeout]

    def complete(self, messages: list[dict[str, str]], schema: dict[str, Any], timeout: float, task: str) -> Completion:
        chat = [_MESSAGE_TYPES[m["role"]](content=m["content"]) for m in messages]
        try:
            reply = self._chat(timeout).invoke(chat, format=schema, stream=False)
        except httpx.TimeoutException as exc:
            raise ProviderFailure("timeout", f"model call timed out after {timeout}s") from exc
        except ResponseError as exc:
            raise ProviderFailure("http_error", f"Ollama returned {exc.status_code}: {str(exc.error)[:200]}") from exc
        except (ConnectionError, httpx.HTTPError) as exc:
            raise ProviderFailure("unavailable", f"Ollama unreachable at {self.host}: {exc.__class__.__name__}") from exc
        usage = reply.usage_metadata or {}
        return Completion(text=str(reply.content), input_tokens=usage.get("input_tokens"), output_tokens=usage.get("output_tokens"))


_MESSAGE_TYPES = {"system": SystemMessage, "user": HumanMessage, "assistant": AIMessage}


class FixtureProvider:
    """Scripted provider for tests: returns queued replies per task (or raises)."""

    name = "fixture"
    model = "fixture-model"

    def __init__(self) -> None:
        self.replies: dict[str, list[Any]] = {}
        self.calls: list[dict[str, Any]] = []

    def queue(self, task: str, *replies: Any) -> None:
        self.replies.setdefault(task, []).extend(replies)

    def complete(self, messages: list[dict[str, str]], schema: dict[str, Any], timeout: float, task: str) -> Completion:
        self.calls.append({"task": task, "messages": messages})
        queue = self.replies.get(task) or []
        if not queue:
            raise ProviderFailure("unavailable", f"no fixture reply queued for {task}")
        reply = queue.pop(0)
        if isinstance(reply, Exception):
            raise reply
        text = reply if isinstance(reply, str) else json.dumps(reply)
        return Completion(text=text, input_tokens=10, output_tokens=10)


_provider_lock = threading.Lock()
_provider_override: dict[str, LLMProvider | None] = {}
_cached: dict[str, LLMProvider] = {}


def set_provider(provider: LLMProvider | None) -> None:
    """Test hook: force a provider (or None to disable AI)."""
    _provider_override["p"] = provider


def clear_provider_override() -> None:
    _provider_override.pop("p", None)


def get_provider() -> LLMProvider | None:
    if "p" in _provider_override:
        return _provider_override["p"]
    s = settings()
    if s.llm_provider == "none" or missing_api_key():
        return None
    with _provider_lock:
        key = f"{s.ollama_host}|{s.llm_model}|{s.llm_think}|{s.ollama_api_key}"
        if key not in _cached:
            _cached[key] = OllamaProvider(s.ollama_host, s.llm_model, s.llm_think, s.ollama_api_key)
        return _cached[key]


def missing_api_key() -> bool:
    """Ollama's cloud API needs OLLAMA_API_KEY. Without it AI stays off (rules only) instead of failing every call."""
    s = settings()
    return s.llm_provider == "ollama" and "ollama.com" in s.ollama_host and not s.ollama_api_key


def describe_provider() -> dict[str, Any]:
    provider = get_provider()
    if provider is None:
        return {"enabled": False, "provider": "rules", "model": None}
    return {"enabled": True, "provider": provider.name, "model": provider.model}


# --------------------------------------------------------------------------- structured invocation


@dataclass
class AIOutcome:
    ok: bool
    data: Any = None
    invocation_id: str | None = None
    reason: str | None = None
    latency_ms: int = 0
    model: str | None = None
    notes: list[str] = field(default_factory=list)


def _inline_refs(schema: dict[str, Any]) -> dict[str, Any]:
    defs = schema.get("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return resolve(defs[node["$ref"].split("/")[-1]])
            return {k: resolve(v) for k, v in node.items() if k not in ("$defs", "title")}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    return resolve(schema)


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def extract_json(text: str) -> Any:
    """Parse the first JSON object in a model reply (tolerates code fences and stray prose)."""
    cleaned = _FENCE.sub("", text.strip())
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    start = cleaned.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escaped = False
        for idx in range(start, len(cleaned)):
            ch = cleaned[idx]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(cleaned[start : idx + 1])
                    except json.JSONDecodeError:
                        break
        start = cleaned.find("{", start + 1)
    raise ValueError("no JSON object found in model reply")


def _record(task: str, prompt_version: str, provider: str, model: str, input_hash: str, result: str,
            reason: str | None, latency_ms: int, tokens: tuple[int | None, int | None], repaired: bool, fallback: bool) -> str:
    inv_id = new_id("ai")
    try:
        with transaction() as db:
            db.add(
                AIInvocation(
                    id=inv_id,
                    task=task,
                    prompt_version=prompt_version,
                    provider=provider,
                    model=model,
                    input_hash=input_hash,
                    validation_result=result,
                    failure_reason=(reason or "")[:500] or None,
                    latency_ms=latency_ms,
                    input_tokens=tokens[0],
                    output_tokens=tokens[1],
                    repaired=repaired,
                    fallback_used=fallback,
                )
            )
    except Exception:  # logging must never break the customer flow
        log.exception("failed to record AI invocation")
    metrics.inc("lastcall_llm_calls_total", task=task, result=result)
    return inv_id


def invoke_structured(
    *,
    task: str,
    prompt_version: str,
    system: str,
    payload: dict[str, Any],
    output_model: type[BaseModel],
    semantic_check: Callable[[Any], list[str]] | None = None,
    timeout: float | None = None,
) -> AIOutcome:
    provider = get_provider()
    safe_payload = redact_obj(payload)
    user = json.dumps(safe_payload, ensure_ascii=False, default=str)
    input_hash = sha256_hex(f"{task}|{prompt_version}|{system}|{user}")
    if provider is None:
        inv = _record(task, prompt_version, "rules", "none", input_hash, "skipped", "AI disabled", 0, (None, None), False, True)
        return AIOutcome(ok=False, invocation_id=inv, reason="ai_disabled")

    schema = _inline_refs(output_model.model_json_schema())
    system_full = (
        f"{system}\n\nRespond with ONLY one JSON object (no prose, no code fences) that validates against "
        f"this JSON Schema, using exactly these keys:\n{json.dumps(schema, separators=(',', ':'))}"
    )
    messages = [{"role": "system", "content": system_full}, {"role": "user", "content": user}]
    timeout = timeout or settings().llm_timeout_seconds
    started = time.perf_counter()
    tokens_in = tokens_out = 0
    repaired = False
    try:
        for attempt in range(2):
            completion = provider.complete(messages, schema, timeout, task)
            tokens_in += completion.input_tokens or 0
            tokens_out += completion.output_tokens or 0
            try:
                parsed = output_model.model_validate(extract_json(completion.text))
            except (ValueError, ValidationError) as exc:
                if attempt == 0:
                    repaired = True
                    messages = messages + [
                        {"role": "assistant", "content": completion.text[:4000]},
                        {"role": "user", "content": f"That reply did not validate: {str(exc)[:600]}. Reply with corrected JSON only."},
                    ]
                    continue
                latency = int((time.perf_counter() - started) * 1000)
                inv = _record(task, prompt_version, provider.name, provider.model, input_hash, "invalid_schema",
                              str(exc), latency, (tokens_in, tokens_out), repaired, True)
                return AIOutcome(ok=False, invocation_id=inv, reason="invalid_schema", latency_ms=latency, model=provider.model)
            problems = semantic_check(parsed) if semantic_check else []
            latency = int((time.perf_counter() - started) * 1000)
            result = "valid" if not problems else "valid_with_rejections"
            inv = _record(task, prompt_version, provider.name, provider.model, input_hash, result,
                          "; ".join(problems) or None, latency, (tokens_in, tokens_out), repaired, False)
            return AIOutcome(ok=True, data=parsed, invocation_id=inv, latency_ms=latency, model=provider.model, notes=problems)
    except ProviderFailure as exc:
        latency = int((time.perf_counter() - started) * 1000)
        inv = _record(task, prompt_version, provider.name, provider.model, input_hash,
                      "timeout" if exc.kind == "timeout" else "error", str(exc), latency, (tokens_in, tokens_out), repaired, True)
        log.warning("llm call failed", extra={"task": task, "kind": exc.kind})
        return AIOutcome(ok=False, invocation_id=inv, reason=exc.kind, latency_ms=latency, model=provider.model)
    return AIOutcome(ok=False, reason="unreachable")  # pragma: no cover
