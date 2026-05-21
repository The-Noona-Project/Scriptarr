from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from oracle_service.app import create_app
from oracle_service.config import OracleConfig
import oracle_service.embedded_localai as embedded_localai_module
from oracle_service.embedded_localai import EmbeddedLocalAiManager
from oracle_service.llm import LOCALAI_MAX_TOKENS, LOCALAI_STOP_SEQUENCES, _provider_completion_options
from oracle_service.runtime_settings import OracleRuntimeSettings


class FakeSageClient:
    def __init__(
        self,
        *,
        bootstrap=None,
        settings=None,
        secret="",
        setting_error: Exception | None = None,
        secret_error: Exception | None = None
    ) -> None:
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
        self.setting_error = setting_error
        self.secret_error = secret_error
        self.requests: list[tuple[str, str]] = []

    async def get_setting(self, key: str):
        self.requests.append(("setting", key))
        if self.setting_error:
            raise self.setting_error
        return {"key": key, "value": self.settings}

    async def get_secret(self, key: str):
        self.requests.append(("secret", key))
        if self.secret_error:
            raise self.secret_error
        return {"key": key, "value": self.secret}

    async def get_bootstrap_status(self):
        self.requests.append(("bootstrap", "bootstrap"))
        return self.bootstrap


class FakeEmbeddedLocalAi:
    def __init__(self, *, ready=True, status=None) -> None:
        self.ready = ready
        self.started = False
        self.prepared = False
        self.stopped = False
        self.ensure_jobs: list[dict] = []
        self.startup_requests: list[dict] = []
        self.probe_count = 0
        self.status_payload = status or {
            "enabled": True,
            "running": True,
            "ready": ready,
            "model": {
                "id": "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
                "present": ready,
                "configured": ready
            },
            "probe": {
                "ready": ready,
                "checkedAt": "2026-05-17T00:00:00Z" if ready else None,
                "error": None if ready else "Generation probe has not passed."
            },
            "job": None,
            "baseUrl": "http://127.0.0.1:8080/v1"
        }

    async def start(self) -> None:
        self.started = True

    async def prepare(self) -> None:
        self.prepared = True

    async def stop(self) -> None:
        self.stopped = True

    async def cancel_startup_auto_start(self) -> None:
        return None

    def record_startup_gate(self, *, gate_reason: str, error: str = ""):
        self.status_payload["startup"] = {
            "phase": "skipped",
            "gateReason": gate_reason,
            "lastError": error,
            "probePassed": False
        }
        return self.status_payload["startup"]

    def start_startup_auto_start(self, runtime_settings):
        payload = {
            "enabled": runtime_settings.enabled,
            "provider": runtime_settings.provider,
            "model": runtime_settings.model
        }
        self.startup_requests.append(payload)
        self.status_payload["startup"] = {
            "phase": "checking",
            "gateReason": "",
            "lastError": "",
            "probePassed": False,
            "model": runtime_settings.model
        }
        return self.status_payload["startup"]

    async def status(self):
        return self.status_payload

    def startup_status(self):
        return self.status_payload.get("startup", {
            "phase": "idle",
            "gateReason": "",
            "lastError": "",
            "probePassed": False,
            "model": ""
        })

    async def is_ready(self) -> bool:
        return self.ready

    async def probe_generation(self, *, force=False):
        self.probe_count += 1
        self.status_payload["ready"] = self.ready
        self.status_payload["probe"] = {
            "ready": self.ready,
            "checkedAt": "2026-05-17T00:00:00Z",
            "error": None if self.ready else "Generation probe failed.",
            "forced": force
        }
        return self.status_payload["probe"]

    def model_options_payload(self, selected_model: str):
        return {
            "ok": True,
            "provider": "localai",
            "selectedModel": selected_model,
            "source": "embedded-oracle",
            "models": [
                {
                    "id": "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
                    "label": "Hermes 3 Llama 3.1 8B Q4_K_S"
                },
                {
                    "id": "Hermes-3-Llama-3.1-8B-Q4_K_M.gguf",
                    "label": "Hermes 3 Llama 3.1 8B Q4_K_M"
                },
                {
                    "id": "Qwen3-8B-Q4_K_M.gguf",
                    "label": "Qwen3 8B Q4_K_M"
                }
            ],
            "status": self.status_payload
        }

    async def start_ensure_job(
        self,
        *,
        action="ensure",
        model_url=None,
        huggingface_token="",
        download_model=True,
        requested_by=None,
        force=False
    ):
        job = {
            "id": "localai-ensure-test",
            "action": action,
            "status": "queued",
            "modelUrl": model_url,
            "hasToken": bool(huggingface_token),
            "downloadModel": download_model,
            "requestedBy": requested_by,
            "force": force
        }
        self.ensure_jobs.append(job)
        self.status_payload["job"] = job
        return job


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


def build_embedded_config() -> OracleConfig:
    return replace(
        build_config(),
        local_ai_embedded_enabled=True,
        model="Hermes-3-Llama-3.1-8B-Q4_K_S.gguf"
    )


def test_embedded_localai_model_config_formats_chat_messages(tmp_path):
    class Logger:
        def warning(self, *args, **kwargs):
            return None

    config = replace(build_embedded_config(), local_ai_models_dir=str(tmp_path))
    manager = EmbeddedLocalAiManager(config=config, logger=Logger())

    config_path = manager._write_model_config()
    body = open(config_path, encoding="utf-8").read()

    assert "chat_message:" in body
    assert "{{.Input}}" in body
    assert ".RoleName" in body
    assert "{{.System}}" not in body


def test_embedded_localai_generation_probe_requires_expected_text(monkeypatch):
    class Logger:
        def warning(self, *args, **kwargs):
            return None

    class FakeResponse:
        status_code = 200

        def json(self):
            return {
                "choices": [
                    {"message": {"content": "Hello from a model, but not the readiness phrase."}}
                ]
            }

    class FakeClient:
        def __init__(self, *args, **kwargs):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr(embedded_localai_module.httpx, "AsyncClient", FakeClient)
    manager = EmbeddedLocalAiManager(config=build_embedded_config(), logger=Logger())

    result = asyncio.run(manager.probe_generation(force=True))

    assert result["ready"] is False
    assert result["status"] == "not_ready"
    assert result["reason"] == "unexpected_completion"
    assert result["expectedTextPresent"] is False


def test_localai_completion_options_are_bounded():
    runtime = OracleRuntimeSettings(
        enabled=True,
        provider="localai",
        model="Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
        temperature=0.2,
        open_ai_api_key_configured=False,
        local_ai_profile_key="nvidia",
        local_ai_image_mode="preset",
        local_ai_custom_image="",
        local_ai_base_url="http://127.0.0.1:8080/v1",
        local_ai_api_key="localai",
        open_ai_api_key="",
        api_key="localai",
        llm_timeout_seconds=180.0
    )

    assert _provider_completion_options(runtime) == {
        "max_tokens": LOCALAI_MAX_TOKENS,
        "stop": LOCALAI_STOP_SEQUENCES,
        "stream": False
    }


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
        "model": "gpt-4.1-mini",
        "embeddedLocalAi": None
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
        "embeddedLocalAi": None,
        "openAiApiKeyConfigured": True,
        "status": {
            "ok": True,
            "callbackUrl": "https://scriptarr.test/api/moon/auth/discord/callback",
            "localAi": {"enabled": False},
            "services": {"vault": {"ok": True}, "sage": {"ok": True}}
        }
    }


def test_health_degrades_when_runtime_settings_are_unavailable():
    sage = FakeSageClient(setting_error=TimeoutError("settings read timed out"))
    app = create_app(config=build_config(), sage_client=sage)

    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["enabled"] is False
    assert payload["provider"] == "openai"
    assert payload["openAiApiKeyConfigured"] is False
    assert payload["status"]["ok"] is True


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


def test_embedded_localai_model_discovery_uses_oracle_model_cache():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "localai",
            "model": "gpt-4",
            "temperature": 0.2
        }
    )
    embedded = FakeEmbeddedLocalAi(ready=True)
    app = create_app(config=build_embedded_config(), sage_client=sage, embedded_local_ai=embedded)

    with TestClient(app) as client:
        response = client.get("/api/models?provider=localai")

    payload = response.json()
    assert payload["ok"] is True
    assert payload["provider"] == "localai"
    assert payload["selectedModel"] == "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf"
    assert payload["source"] == "embedded-oracle"
    assert [entry["id"] for entry in payload["models"]] == [
        "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
        "Hermes-3-Llama-3.1-8B-Q4_K_M.gguf",
        "Qwen3-8B-Q4_K_M.gguf"
    ]
    assert embedded.prepared is True
    assert embedded.started is False


def test_embedded_localai_status_and_install_action_are_oracle_owned():
    sage = FakeSageClient()
    embedded = FakeEmbeddedLocalAi(ready=False)
    app = create_app(config=build_embedded_config(), sage_client=sage, embedded_local_ai=embedded)

    with TestClient(app) as client:
        status_response = client.get("/api/localai/status")
        probe_response = client.post("/api/localai/probe", json={"force": True})
        install_response = client.post(
            "/api/localai/actions/install",
            json={"model": "Hermes-3-Llama-3.1-8B-Q4_K_M.gguf", "requestedBy": {"kind": "owner"}}
        )

    assert status_response.json()["enabled"] is True
    assert probe_response.json()["ready"] is False
    assert embedded.probe_count == 1
    install_payload = install_response.json()
    assert install_payload["ok"] is True
    assert install_payload["job"]["action"] == "install"
    assert install_payload["job"]["modelUrl"] == "Hermes-3-Llama-3.1-8B-Q4_K_M.gguf"
    assert install_payload["job"]["requestedBy"] == {"kind": "owner"}


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


def test_localai_chat_ignores_openai_secret_lookup_failure():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "localai",
            "model": "gpt-4.1-mini",
            "temperature": 0.2
        },
        secret_error=TimeoutError("secret read timed out")
    )

    async def available_probe(_runtime):
        return True

    async def fake_invoke(runtime, persona_name, message):
        assert runtime.provider == "localai"
        assert runtime.api_key == "localai"
        return f"{persona_name} heard through LocalAI: {message}"

    app = create_app(
        config=build_config(),
        sage_client=sage,
        probe_local_ai_fn=available_probe,
        invoke_oracle_fn=fake_invoke
    )

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "Say hi"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload.get("degraded") is None
    assert payload["reply"] == "Noona heard through LocalAI: Say hi"


def test_embedded_localai_requires_generation_probe_before_chat():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "localai",
            "model": "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
            "temperature": 0.2
        }
    )
    embedded = FakeEmbeddedLocalAi(ready=False)
    app = create_app(config=build_embedded_config(), sage_client=sage, embedded_local_ai=embedded)

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "Say hi"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["degraded"] is True
    assert payload["reply"] == "Noona is in read-only fallback mode because LocalAI is unavailable right now."
    assert payload["error"] == "LocalAI probe failed."


def test_embedded_localai_retries_startup_after_settings_become_enabled():
    sage = FakeSageClient(
        settings={
            "enabled": True,
            "provider": "localai",
            "model": "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
            "temperature": 0.2
        }
    )
    embedded = FakeEmbeddedLocalAi(ready=False)
    app = create_app(config=build_embedded_config(), sage_client=sage, embedded_local_ai=embedded)

    with TestClient(app) as client:
        embedded.startup_requests.clear()
        embedded.status_payload["startup"] = {
            "phase": "skipped",
            "gateReason": "oracle_disabled",
            "lastError": "",
            "probePassed": False,
            "model": ""
        }
        response = client.post("/api/chat", json={"message": "Say hi"})

    payload = response.json()
    assert payload["ok"] is True
    assert payload["degraded"] is True
    assert embedded.startup_requests == [{
        "enabled": True,
        "provider": "localai",
        "model": "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf"
    }]
    assert embedded.status_payload["startup"]["phase"] == "checking"


def test_embedded_localai_verify_generation_retries_first_load_failure():
    class Logger:
        def warning(self, *args, **kwargs):
            return None

    manager = EmbeddedLocalAiManager(config=build_embedded_config(), logger=Logger())
    probes = [
        {"ready": False, "status": "not_ready", "reason": "generation_error"},
        {"ready": True, "status": "ready", "reason": "generated", "sample": "ready"}
    ]

    async def fake_probe_generation(*, force=False, model_url=None):
        assert force is True
        return probes.pop(0)

    manager.probe_generation = fake_probe_generation

    result = asyncio.run(manager.verify_generation(attempts=2, delay_seconds=0))

    assert result["ready"] is True
    assert result["attempt"] == 2
    assert probes == []


def test_embedded_localai_startup_autostart_skips_when_oracle_is_disabled():
    class Logger:
        def warning(self, *args, **kwargs):
            return None

    manager = EmbeddedLocalAiManager(config=build_embedded_config(), logger=Logger())
    runtime = OracleRuntimeSettings(
        enabled=False,
        provider="localai",
        model="Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
        temperature=0.2,
        open_ai_api_key_configured=False,
        local_ai_profile_key="nvidia",
        local_ai_image_mode="preset",
        local_ai_custom_image="",
        local_ai_base_url="http://127.0.0.1:8080/v1",
        local_ai_api_key="localai",
        open_ai_api_key="",
        api_key="localai",
        llm_timeout_seconds=180.0
    )

    result = asyncio.run(manager.run_startup_auto_start(runtime))

    assert result["phase"] == "skipped"
    assert result["gateReason"] == "oracle_disabled"
    assert result["probePassed"] is False


def test_embedded_localai_startup_autostart_requires_installed_model(tmp_path):
    class Logger:
        def warning(self, *args, **kwargs):
            return None

    config = replace(
        build_embedded_config(),
        local_ai_models_dir=str(tmp_path / "models"),
        local_ai_data_dir=str(tmp_path / "data"),
        local_ai_backends_path=str(tmp_path / "backends"),
        local_ai_tmp_dir=str(tmp_path / "tmp"),
        local_ai_backend_assets_path=str(tmp_path / "assets"),
        local_ai_generated_content_path=str(tmp_path / "generated"),
        local_ai_upload_path=str(tmp_path / "uploads")
    )
    manager = EmbeddedLocalAiManager(config=config, logger=Logger())
    started = {"count": 0}

    async def fake_start(*, model_url=None):
        started["count"] += 1

    manager.start = fake_start
    runtime = OracleRuntimeSettings(
        enabled=True,
        provider="localai",
        model="Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
        temperature=0.2,
        open_ai_api_key_configured=False,
        local_ai_profile_key="nvidia",
        local_ai_image_mode="preset",
        local_ai_custom_image="",
        local_ai_base_url="http://127.0.0.1:8080/v1",
        local_ai_api_key="localai",
        open_ai_api_key="",
        api_key="localai",
        llm_timeout_seconds=180.0
    )

    result = asyncio.run(manager.run_startup_auto_start(runtime))

    assert result["phase"] == "skipped"
    assert result["gateReason"] == "model_not_installed"
    assert started["count"] == 0


def test_embedded_localai_startup_autostart_requires_generation_probe(tmp_path):
    class Logger:
        def warning(self, *args, **kwargs):
            return None

    config = replace(
        build_embedded_config(),
        local_ai_models_dir=str(tmp_path / "models"),
        local_ai_data_dir=str(tmp_path / "data"),
        local_ai_backends_path=str(tmp_path / "backends"),
        local_ai_tmp_dir=str(tmp_path / "tmp"),
        local_ai_backend_assets_path=str(tmp_path / "assets"),
        local_ai_generated_content_path=str(tmp_path / "generated"),
        local_ai_upload_path=str(tmp_path / "uploads")
    )
    manager = EmbeddedLocalAiManager(config=config, logger=Logger())
    model = manager.model_status(config.local_ai_default_model_url)
    Path(model["path"]).parent.mkdir(parents=True, exist_ok=True)
    Path(model["path"]).write_bytes(b"fake-gguf")
    Path(config.local_ai_backends_path).mkdir(parents=True, exist_ok=True)
    Path(config.local_ai_backends_path, "llama-cpp").write_text("backend", encoding="utf-8")
    calls = {"start": 0, "probe": 0}

    async def fake_start(*, model_url=None):
        calls["start"] += 1

    async def fake_wait_until_ready():
        return {"ready": True}

    async def fake_verify_generation(*, model_url=None):
        calls["probe"] += 1
        return {"ready": True, "status": "ready", "reason": "generated"}

    manager.start = fake_start
    manager.wait_until_ready = fake_wait_until_ready
    manager.verify_generation = fake_verify_generation
    runtime = OracleRuntimeSettings(
        enabled=True,
        provider="localai",
        model="Hermes-3-Llama-3.1-8B-Q4_K_S.gguf",
        temperature=0.2,
        open_ai_api_key_configured=False,
        local_ai_profile_key="nvidia",
        local_ai_image_mode="preset",
        local_ai_custom_image="",
        local_ai_base_url="http://127.0.0.1:8080/v1",
        local_ai_api_key="localai",
        open_ai_api_key="",
        api_key="localai",
        llm_timeout_seconds=180.0
    )

    result = asyncio.run(manager.run_startup_auto_start(runtime))

    assert result["phase"] == "ready"
    assert result["probePassed"] is True
    assert result["model"] == "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf"
    assert calls == {"start": 1, "probe": 1}


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
