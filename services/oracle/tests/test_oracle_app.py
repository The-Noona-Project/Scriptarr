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
    assert payload["reply"] == "Noona is in read-only fallback mode because LocalAI is unavailable right now."
    assert payload["error"] == "boom"
