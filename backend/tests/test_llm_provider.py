"""The LLM adapter: Ollama through LangChain (ChatOllama), authenticated with an API key for Ollama's cloud API.

Ollama's HTTP API is replaced by an httpx mock transport, so these tests check the real request LangChain sends."""

from __future__ import annotations

import json

import httpx
import pytest
from sqlalchemy import select

from app.ai import provider as ai_provider
from app.ai.provider import OllamaProvider, ProviderFailure, describe_provider, get_provider
from app.config import override_settings, settings
from app.db import transaction
from app.models import AIInvocation

from .helpers import ok

SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
MESSAGES = [{"role": "system", "content": "Reply with JSON."}, {"role": "user", "content": "Are you there?"}]


def _reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={
        "model": "gpt-oss:120b", "created_at": "2026-11-05T10:00:00Z",
        "message": {"role": "assistant", "content": content, "thinking": "A short check."},
        "done": True, "done_reason": "stop", "prompt_eval_count": 42, "eval_count": 7,
    })


def _cloud(handler, api_key: str | None = "test-key") -> OllamaProvider:
    return OllamaProvider("https://ollama.com", "gpt-oss:120b", "low", api_key, client_kwargs={"transport": httpx.MockTransport(handler)})


def _use_settings(**changes) -> None:
    override_settings(**(settings().model_dump() | changes))
    ai_provider.clear_provider_override()


def test_cloud_call_goes_through_langchain_with_the_api_key():
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return _reply('{"ok": true}')

    completion = _cloud(handler).complete(MESSAGES, SCHEMA, 5.0, "L1_intent")
    assert json.loads(completion.text) == {"ok": True}  # the reasoning stays out of the reply
    assert (completion.input_tokens, completion.output_tokens) == (42, 7)
    request = sent[0]
    assert str(request.url) == "https://ollama.com/api/chat"
    assert request.headers["authorization"] == "Bearer test-key"
    body = json.loads(request.content)
    assert body["model"] == "gpt-oss:120b" and body["think"] == "low" and body["stream"] is False
    assert body["format"] == SCHEMA and body["options"]["temperature"] == 0
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


def _unauthorized(request: httpx.Request) -> httpx.Response:
    return httpx.Response(401, json={"error": "unauthorized"})


def _too_slow(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("model call too slow", request=request)


def _unreachable(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


@pytest.mark.parametrize(("handler", "kind"), [(_unauthorized, "http_error"), (_too_slow, "timeout"), (_unreachable, "unavailable")])
def test_provider_errors_become_fallback_reasons(handler, kind):
    with pytest.raises(ProviderFailure) as failure:
        _cloud(handler).complete(MESSAGES, SCHEMA, 5.0, "L1_intent")
    assert failure.value.kind == kind


def test_cloud_api_without_a_key_keeps_ai_off():
    _use_settings(llm_provider="ollama", ollama_host="https://ollama.com", ollama_api_key=None)
    assert get_provider() is None
    assert describe_provider()["enabled"] is False


def test_api_key_turns_on_the_cloud_model():
    _use_settings(llm_provider="ollama", ollama_host="https://ollama.com", ollama_api_key="test-key", llm_model="gpt-oss:120b")
    assert isinstance(get_provider(), OllamaProvider)
    assert describe_provider() == {"enabled": True, "provider": "langchain-ollama", "model": "gpt-oss:120b"}


def test_local_daemon_needs_no_key():
    _use_settings(llm_provider="ollama", ollama_host="http://localhost:11434", ollama_api_key=None, llm_model="gpt-oss:120b-cloud")
    assert isinstance(get_provider(), OllamaProvider)


def test_request_parsing_uses_the_cloud_model_through_langchain(client, bakery):
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return _reply(json.dumps({"party_size": 4, "budget_minor": 1800, "exclusions": [], "dietary": [], "preferences": []}))

    ai_provider.set_provider(_cloud(handler))
    parsed = ok(client.post("/api/intents/parse", json={"text": "snacks for 4 people under $18", "controls": {}, "use_ai": True, "merchant": "juniper-rye"}))
    assert parsed["parser"] == "ai+rules"
    assert parsed["intent"]["party_size"] == 4 and parsed["intent"]["budget_minor"] == 1800
    assert "snacks for 4 people" in sent[0]["messages"][-1]["content"]
    with transaction() as db:
        call = db.scalar(select(AIInvocation).where(AIInvocation.task == "L1_intent"))
        assert (call.provider, call.model) == ("langchain-ollama", "gpt-oss:120b")
        assert call.validation_result.startswith("valid") and call.input_tokens == 42
