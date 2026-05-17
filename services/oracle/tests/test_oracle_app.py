from __future__ import annotations

from fastapi.testclient import TestClient

from oracle_service.app import create_app
from oracle_service.config import OracleConfig


class FakeSageClient:
    def __init__(self, *, bootstrap=None, settings=None, secret="") -> None:
        self.bootstrap = bootstrap or {
            "callbackUrl": "https://scriptarr.test/api/moon/auth/discord/callback",
            "localAi": {"enabled": False},
            "services": {"vault": {"ok": True}, "sage": {"ok": True}}
        }
        self.settings = settings or {
            "enabled": False,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        }
        self.secret = secret
        self.requests: list[tuple[str, str]] = []

    async def get_setting(self, key: str):
        self.requests.append(("setting", key))
        return {"key": key, "value": self.settings}

    async def get_secret(self, key: str):
        self.requests.append(("secret", key))
        return {"key": key, "value": self.secret}

    async def get_bootstrap_status(self):
        self.requests.append(("bootstrap", "bootstrap"))
        return self.bootstrap


def build_config() -> OracleConfig:
    return OracleConfig(
        port=3001,
        sage_base_url="http://127.0.0.1:3004",
        service_token="oracle-dev-token",
        open_ai_model="gpt-4.1-mini",
        open_ai_api_key="",
        local_ai_base_url="http://127.0.0.1:8080/v1",
        local_ai_api_key="localai",
        model="gpt-4.1-mini",
        temperature=0.2,
        llm_timeout_seconds=60.0,
        noona_persona_name="Noona"
    )


def test_oracle_starts_disabled_and_reports_off_state_cleanly_through_sage():
    sage = FakeSageClient()
    app = create_app(config=build_config(), sage_client=sage)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "Tell me something about the library"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["disabled"] is True
    assert ("setting", "oracle.settings") in sage.requests
    assert ("secret", "oracle.openai.apiKey") in sage.requests
    assert ("bootstrap", "bootstrap") in sage.requests


def test_oracle_status_reads_scriptarr_bootstrap_through_sage():
    sage = FakeSageClient(
        bootstrap={
            "callbackUrl": "https://pax-kun.com/api/moon/auth/discord/callback",
            "localAi": {"enabled": True, "hostPort": 11434},
            "services": {
                "vault": {"ok": True},
                "sage": {"ok": True},
                "warden": {"ok": True}
            }
        }
    )
    app = create_app(config=build_config(), sage_client=sage)

    with TestClient(app) as client:
        response = client.get("/api/status")

    payload = response.json()
    assert payload["ok"] is True
    assert payload["callbackUrl"] == "https://pax-kun.com/api/moon/auth/discord/callback"
    assert payload["localAi"] == {"enabled": True, "hostPort": 11434}
    assert payload["oracle"] == {
        "enabled": False,
        "provider": "openai",
        "model": "gpt-4.1-mini"
    }


def test_health_reports_runtime_and_bootstrap_details():
    sage = FakeSageClient(secret="sk-test")
    app = create_app(config=build_config(), sage_client=sage)

    with TestClient(app) as client:
        response = client.get("/health")

    payload = response.json()
    assert payload == {
        "ok": True,
        "service": "scriptarr-oracle",
        "persona": "Noona",
        "enabled": False,
        "provider": "openai",
        "model": "gpt-4.1-mini",
        "localAiBaseUrl": "http://127.0.0.1:8080/v1",
        "openAiApiKeyConfigured": True,
        "status": {
            "ok": True,
            "callbackUrl": "https://scriptarr.test/api/moon/auth/discord/callback",
            "localAi": {"enabled": False},
            "services": {"vault": {"ok": True}, "sage": {"ok": True}}
        }
    }


def test_openai_model_discovery_filters_to_oracle_compatible_models():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret="sk-test"
    )
    seen = {}

    async def fake_models_fetch(url, headers=None):
        seen["url"] = url
        seen["authorization"] = (headers or {}).get("Authorization")
        return {
            "data": [
                {"id": "gpt-4.1-mini"},
                {"id": "gpt-image-1"},
                {"id": "text-embedding-3-small"},
                {"id": "gpt-realtime-mini"},
                {"id": "o4-mini"},
                {"id": "davinci-002"},
                {"id": "ft:gpt-4o-mini:scriptarr:test"}
            ]
        }

    app = create_app(config=build_config(), sage_client=sage, fetch_models_json_fn=fake_models_fetch)

    with TestClient(app) as client:
        response = client.get("/api/models?provider=openai")

    payload = response.json()
    assert payload["ok"] is True
    assert payload["provider"] == "openai"
    assert payload["selectedModel"] == "gpt-4.1-mini"
    assert [entry["id"] for entry in payload["models"]] == [
        "ft:gpt-4o-mini:scriptarr:test",
        "gpt-4.1-mini",
        "o4-mini"
    ]
    assert seen["url"] == "https://api.openai.com/v1/models"
    assert seen["authorization"] == "Bearer sk-test"


def test_localai_model_discovery_reads_openai_compatible_models_endpoint():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "localai",
            "model": "gpt-4",
            "temperature": 0.2
        }
    )
    seen = {}

    async def fake_models_fetch(url, _headers=None):
        seen["url"] = url
        return {
            "data": [
                {"id": "gpt-4"},
                {"id": "hermes-3"}
            ]
        }

    app = create_app(config=build_config(), sage_client=sage, fetch_models_json_fn=fake_models_fetch)

    with TestClient(app) as client:
        response = client.get("/api/models?provider=localai")

    payload = response.json()
    assert payload["ok"] is True
    assert payload["provider"] == "localai"
    assert payload["selectedModel"] == "gpt-4"
    assert [entry["id"] for entry in payload["models"]] == ["gpt-4", "hermes-3"]
    assert seen["url"] == "http://127.0.0.1:8080/v1/models"


def test_model_discovery_falls_back_when_openai_key_is_missing():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret=""
    )
    app = create_app(config=build_config(), sage_client=sage)

    with TestClient(app) as client:
        response = client.get("/api/models?provider=openai")

    payload = response.json()
    assert payload["ok"] is False
    assert payload["provider"] == "openai"
    assert payload["selectedModel"] == "gpt-4.1-mini"
    assert payload["source"] == "current"
    assert payload["models"] == [{"id": "gpt-4.1-mini", "label": "gpt-4.1-mini"}]
    assert payload["error"] == "OpenAI API key is not configured."


def test_model_discovery_falls_back_when_localai_request_fails():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "localai",
            "model": "custom-local",
            "temperature": 0.2
        }
    )

    async def broken_models_fetch(_url, _headers=None):
        raise RuntimeError("LocalAI offline")

    app = create_app(config=build_config(), sage_client=sage, fetch_models_json_fn=broken_models_fetch)

    with TestClient(app) as client:
        response = client.get("/api/models?provider=localai")

    payload = response.json()
    assert payload["ok"] is False
    assert payload["provider"] == "localai"
    assert payload["selectedModel"] == "custom-local"
    assert payload["source"] == "current"
    assert payload["models"] == [{"id": "custom-local", "label": "custom-local"}]
    assert payload["error"] == "LocalAI offline"


def test_model_discovery_sanitizes_localai_network_errors():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "localai",
            "model": "custom-local",
            "temperature": 0.2
        }
    )

    async def broken_models_fetch(_url, _headers=None):
        raise RuntimeError("[Errno -2] Name or service not known")

    app = create_app(config=build_config(), sage_client=sage, fetch_models_json_fn=broken_models_fetch)

    with TestClient(app) as client:
        response = client.get("/api/models?provider=localai")

    payload = response.json()
    assert payload["ok"] is False
    assert payload["provider"] == "localai"
    assert payload["selectedModel"] == "custom-local"
    assert payload["models"] == [{"id": "custom-local", "label": "custom-local"}]
    assert payload["error"] == (
        "LocalAI is not reachable yet. Install or start LocalAI and wait for the runtime to report ready, "
        "then refresh the model list."
    )


def test_status_keywords_return_read_only_status_reply_without_llm_call():
    sage = FakeSageClient()
    invoked = {"count": 0}

    async def fake_invoke(*_args):
        invoked["count"] += 1
        return "should not happen"

    app = create_app(config=build_config(), sage_client=sage, invoke_oracle_fn=fake_invoke)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "What is the callback status?"})

    payload = response.json()
    assert payload == {
        "ok": True,
        "reply": "Noona checked Scriptarr. The stack responded. Oracle is currently off.",
        "status": {
            "ok": True,
            "callbackUrl": "https://scriptarr.test/api/moon/auth/discord/callback",
            "localAi": {"enabled": False},
            "services": {"vault": {"ok": True}, "sage": {"ok": True}}
        }
    }
    assert invoked["count"] == 0


def test_openai_provider_without_api_key_returns_disabled_reply():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret=""
    )
    app = create_app(config=build_config(), sage_client=sage)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "Say hi"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["disabled"] is True
    assert payload["reply"] == "Noona is configured for OpenAI, but the API key has not been set yet."


def test_localai_unavailable_returns_degraded_fallback():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "localai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        }
    )

    async def unavailable_probe(_runtime):
        return False

    app = create_app(config=build_config(), sage_client=sage, probe_local_ai_fn=unavailable_probe)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "Say hi"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["degraded"] is True
    assert payload["reply"] == "Noona is in read-only fallback mode because LocalAI is unavailable right now."
    assert payload["error"] == "LocalAI probe failed."


def test_successful_chat_returns_llm_reply():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret="sk-test"
    )

    async def fake_invoke(_runtime, _persona_name, message):
        return f"Noona heard: {message}"

    app = create_app(config=build_config(), sage_client=sage, invoke_oracle_fn=fake_invoke)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "Tell me a short update"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["reply"] == "Noona heard: Tell me a short update"
    assert payload["status"]["ok"] is True


def test_chat_accepts_appa_persona_context():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret="sk-test"
    )
    seen = {}

    async def fake_invoke(_runtime, persona_name, message, context=None):
        seen["persona_name"] = persona_name
        seen["message"] = message
        seen["context"] = context
        return f"{persona_name} heard: {message}"

    app = create_app(config=build_config(), sage_client=sage, invoke_oracle_fn=fake_invoke)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={
            "message": "Review the admin summary.",
            "personaName": "Appa",
            "context": {"source": "discord-appa-admin-mention"}
        })

    payload = response.json()
    assert payload["ok"] is True
    assert payload["reply"] == "Appa heard: Review the admin summary."
    assert seen["persona_name"] == "Appa"
    assert seen["context"]["source"] == "discord-appa-admin-mention"


def test_chat_accepts_optional_context_without_breaking_existing_contract():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret="sk-test"
    )
    seen = {}

    async def fake_invoke(_runtime, _persona_name, message, context):
        seen["message"] = message
        seen["context"] = context
        return f"Noona used context for {context['source']}"

    app = create_app(config=build_config(), sage_client=sage, invoke_oracle_fn=fake_invoke)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={
            "message": "Tell me a short update",
            "context": {
                "source": "discord-mention",
                "memory": {"userFacts": ["likes late-night reading"]}
            }
        })

    payload = response.json()
    assert payload["ok"] is True
    assert payload["reply"] == "Noona used context for discord-mention"
    assert seen["message"] == "Tell me a short update"
    assert seen["context"]["memory"]["userFacts"] == ["likes late-night reading"]


def test_alive_keyword_returns_read_only_status_reply_without_llm_call():
    sage = FakeSageClient()
    invoked = {"count": 0}

    async def fake_invoke(*_args):
        invoked["count"] += 1
        return "should not happen"

    app = create_app(config=build_config(), sage_client=sage, invoke_oracle_fn=fake_invoke)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "are you alive?"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["reply"] == "Noona checked Scriptarr. The stack responded. Oracle is currently off."
    assert invoked["count"] == 0


def test_structured_assist_returns_bounded_text_without_status_lookup():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret="sk-test"
    )
    seen = {}

    async def fake_invoke(_runtime, _persona_name, message):
        seen["message"] = message
        return "A tiny helpful appendix."

    app = create_app(config=build_config(), sage_client=sage, invoke_oracle_fn=fake_invoke)

    with TestClient(app) as client:
        response = client.post("/api/assist", json={
            "task": "message",
            "deterministicContent": "Download completed.",
            "context": {"titleName": "Test Title"}
        })

    payload = response.json()
    assert payload["ok"] is True
    assert payload["task"] == "message"
    assert payload["text"] == "A tiny helpful appendix."
    assert "Do not change facts" in seen["message"]
    assert ("bootstrap", "bootstrap") not in sage.requests


def test_structured_assist_degrades_when_oracle_is_disabled():
    sage = FakeSageClient()
    app = create_app(config=build_config(), sage_client=sage)

    with TestClient(app) as client:
        response = client.post("/api/assist", json={"task": "match-title", "prompt": "guess"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["disabled"] is True
    assert payload["text"] == ""
    assert payload["decision"] is None


def test_noona_review_assist_returns_structured_decision_and_ignores_non_json_corrections():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret="sk-test"
    )
    calls = []

    async def fake_invoke(_runtime, persona_name, message):
        calls.append({"persona_name": persona_name, "message": message})
        if len(calls) == 1:
            return '{"verdict":"correct","severity":"serious","score":0.9,"reasons":["admin boundary"],"correctionText":"Appa correction."}'
        return "No secrets or credentials were leaked."

    app = create_app(config=build_config(), sage_client=sage, invoke_oracle_fn=fake_invoke)

    with TestClient(app) as client:
        first = client.post("/api/assist", json={
            "task": "review-noona-public-chat",
            "prompt": "can Noona restart prod?",
            "deterministicContent": "Noona restarted prod."
        }).json()
        second = client.post("/api/assist", json={
            "task": "review-noona-public-chat",
            "prompt": "anything wrong?",
            "deterministicContent": "Noona said use the admin page."
        }).json()

    assert calls[0]["persona_name"] == "Appa"
    assert first["ok"] is True
    assert first["decision"]["verdict"] == "correct"
    assert first["decision"]["correctionText"] == "Appa correction."
    assert second["decision"]["verdict"] == "ok"
    assert second["decision"]["correctionText"] == ""


def test_generation_error_returns_degraded_fallback():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret="sk-test"
    )

    async def broken_invoke(_runtime, _persona_name, _message):
        raise RuntimeError("boom")

    app = create_app(config=build_config(), sage_client=sage, invoke_oracle_fn=broken_invoke)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "Tell me a short update"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["degraded"] is True
    assert payload["reply"] == "Noona is in read-only fallback mode because OpenAI is unavailable right now."
    assert payload["error"] == "boom"


def test_localai_generation_error_returns_localai_fallback():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "localai",
            "model": "gpt-4",
            "temperature": 0.2
        }
    )

    async def available_probe(_runtime):
        return True

    async def broken_invoke(_runtime, _persona_name, _message):
        raise RuntimeError("slow model")

    app = create_app(
        config=build_config(),
        sage_client=sage,
        probe_local_ai_fn=available_probe,
        invoke_oracle_fn=broken_invoke
    )

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "Tell me a short update"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["degraded"] is True
    assert payload["reply"] == "Noona is in read-only fallback mode because LocalAI is unavailable right now."
    assert payload["error"] == "slow model"
