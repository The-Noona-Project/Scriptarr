from __future__ import annotations

import asyncio
import logging
import re

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import OracleConfig, resolve_oracle_config
from .llm import invoke_oracle
from .runtime_settings import resolve_oracle_runtime_settings
from .sage_client import SageClient
from .status import read_scriptarr_status

LOGGER = logging.getLogger("scriptarr.oracle")
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
LOCALAI_DEFAULT_MODEL = "gpt-4"
OPENAI_COMPATIBLE_PREFIXES = ("gpt-", "o1", "o3", "o4", "chatgpt-")
OPENAI_INCOMPATIBLE_MODEL_TOKENS = (
    "audio",
    "babbage",
    "codex",
    "computer-use",
    "dall-e",
    "davinci",
    "embedding",
    "image",
    "moderation",
    "realtime",
    "search",
    "sora",
    "transcribe",
    "tts",
    "whisper"
)


def _localai_models_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/v1"):
        normalized = normalized[:-3]
    return f"{normalized}/v1/models"


async def probe_local_ai(runtime) -> bool:
    try:
        async with httpx.AsyncClient(timeout=1.2) as client:
            response = await client.get(_localai_models_url(runtime.local_ai_base_url))
        return response.is_success
    except Exception:  # noqa: BLE001
        return False


def _provider_label(provider: str) -> str:
    return "LocalAI" if provider == "localai" else "OpenAI" if provider == "openai" else "the AI provider"


def _provider_fallback_reply(persona_name: str, provider: str) -> str:
    return f"{persona_name} is in read-only fallback mode because {_provider_label(provider)} is unavailable right now."


def _normalize_string(value: object, fallback: str = "") -> str:
    normalized = str(value).strip() if value is not None else ""
    return normalized or fallback


def _normalize_provider(value: object, fallback: str = "openai") -> str:
    normalized = _normalize_string(value, fallback).lower()
    return normalized if normalized in {"openai", "localai"} else fallback


def _short_string(value: object, limit: int = 600) -> str:
    normalized = _normalize_string(value)
    return normalized[:limit].strip()


def _assist_fallback(task: str) -> dict[str, object]:
    return {
        "ok": True,
        "degraded": True,
        "task": task,
        "text": "",
        "decision": None
    }


def _provider_default_model(provider: str, config: OracleConfig) -> str:
    if provider == "localai":
        return LOCALAI_DEFAULT_MODEL
    return _normalize_string(config.open_ai_model, "gpt-4.1-mini")


def _selected_model_for_provider(provider: str, runtime, config: OracleConfig) -> str:
    if provider == runtime.provider:
        return _normalize_string(runtime.model, _provider_default_model(provider, config))
    return _provider_default_model(provider, config)


def _model_option(model_id: str) -> dict[str, str]:
    return {
        "id": model_id,
        "label": model_id
    }


def _extract_model_ids(payload: object) -> list[str]:
    data = payload.get("data") if isinstance(payload, dict) else payload
    entries = data if isinstance(data, list) else []
    model_ids: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        model_id = _normalize_string(entry.get("id") if isinstance(entry, dict) else entry)
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        model_ids.append(model_id)
    return model_ids


def _is_oracle_compatible_openai_model(model_id: str) -> bool:
    normalized = model_id.lower()
    candidate = normalized[3:] if normalized.startswith("ft:") else normalized
    if any(token in candidate for token in OPENAI_INCOMPATIBLE_MODEL_TOKENS):
        return False
    return candidate.startswith(OPENAI_COMPATIBLE_PREFIXES)


def _fallback_models_payload(provider: str, selected_model: str, config: OracleConfig, error: str) -> dict[str, object]:
    fallback_model = _normalize_string(selected_model, _provider_default_model(provider, config))
    return {
        "provider": provider,
        "selectedModel": fallback_model,
        "models": [_model_option(fallback_model)],
        "source": "current" if _normalize_string(selected_model) else "default",
        "ok": False,
        "error": error
    }


def _models_payload(provider: str, model_ids: list[str], selected_model: str, config: OracleConfig) -> dict[str, object]:
    unique_ids = sorted(dict.fromkeys(model_ids), key=lambda value: value.lower())
    if not unique_ids:
        return _fallback_models_payload(provider, selected_model, config, "No compatible models were returned.")
    selected = _normalize_string(selected_model)
    default_model = _provider_default_model(provider, config)
    if selected not in unique_ids:
        selected = default_model if default_model in unique_ids else unique_ids[0]
    return {
        "provider": provider,
        "selectedModel": selected,
        "models": [_model_option(model_id) for model_id in unique_ids],
        "source": "live",
        "ok": True,
        "error": None
    }


async def fetch_models_json(url: str, headers: dict[str, str] | None = None) -> object:
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(url, headers=headers or {})
    response.raise_for_status()
    return response.json()


async def discover_provider_models(*, provider: str, runtime, config: OracleConfig, fetch_models_json_fn=fetch_models_json) -> dict[str, object]:
    normalized_provider = _normalize_provider(provider, runtime.provider)
    selected_model = _selected_model_for_provider(normalized_provider, runtime, config)

    try:
        if normalized_provider == "localai":
            payload = await fetch_models_json_fn(_localai_models_url(runtime.local_ai_base_url), {})
            return _models_payload(normalized_provider, _extract_model_ids(payload), selected_model, config)

        if not runtime.open_ai_api_key_configured:
            return _fallback_models_payload(normalized_provider, selected_model, config, "OpenAI API key is not configured.")

        payload = await fetch_models_json_fn(OPENAI_MODELS_URL, {
            "Authorization": f"Bearer {runtime.open_ai_api_key}"
        })
        model_ids = [model_id for model_id in _extract_model_ids(payload) if _is_oracle_compatible_openai_model(model_id)]
        return _models_payload(normalized_provider, model_ids, selected_model, config)
    except Exception as error:  # noqa: BLE001
        return _fallback_models_payload(normalized_provider, selected_model, config, str(error))


def create_app(
    *,
    logger: logging.Logger | None = None,
    config: OracleConfig | None = None,
    sage_client=None,
    probe_local_ai_fn=probe_local_ai,
    invoke_oracle_fn=invoke_oracle,
    fetch_models_json_fn=fetch_models_json
) -> FastAPI:
    active_logger = logger or LOGGER
    active_config = config or resolve_oracle_config()
    active_sage_client = sage_client or SageClient(active_config.sage_base_url, active_config.service_token)
    app = FastAPI()

    @app.get("/health")
    async def health() -> dict[str, object]:
        status, runtime = await asyncio.gather(
            read_scriptarr_status(active_sage_client),
            resolve_oracle_runtime_settings(config=active_config, sage_client=active_sage_client)
        )
        return {
            "ok": True,
            "service": "scriptarr-oracle",
            "persona": active_config.noona_persona_name,
            "enabled": runtime.enabled,
            "provider": runtime.provider,
            "model": runtime.model,
            "localAiBaseUrl": runtime.local_ai_base_url,
            "openAiApiKeyConfigured": runtime.open_ai_api_key_configured,
            "status": status
        }

    @app.get("/api/status")
    async def status() -> dict[str, object]:
        status_payload, runtime = await asyncio.gather(
            read_scriptarr_status(active_sage_client),
            resolve_oracle_runtime_settings(config=active_config, sage_client=active_sage_client)
        )
        return {
            **status_payload,
            "oracle": {
                "enabled": runtime.enabled,
                "provider": runtime.provider,
                "model": runtime.model
            }
        }

    @app.get("/api/models")
    async def models(request: Request) -> dict[str, object]:
        runtime = await resolve_oracle_runtime_settings(config=active_config, sage_client=active_sage_client)
        provider = _normalize_provider(request.query_params.get("provider"), runtime.provider)
        return await discover_provider_models(
            provider=provider,
            runtime=runtime,
            config=active_config,
            fetch_models_json_fn=fetch_models_json_fn
        )

    @app.post("/api/chat")
    async def chat(request: Request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        message = str((body or {}).get("message") or "").strip()
        context = (body or {}).get("context") if isinstance(body, dict) else None
        if not message:
            active_logger.warning("Oracle chat request was missing a message.")
            return JSONResponse(status_code=400, content={"error": "message is required."})

        status_payload, runtime = await asyncio.gather(
            read_scriptarr_status(active_sage_client),
            resolve_oracle_runtime_settings(config=active_config, sage_client=active_sage_client)
        )
        if re.search(r"status|health|boot|callback|alive", message, re.IGNORECASE):
            return {
                "ok": True,
                "reply": (
                    f"{active_config.noona_persona_name} checked Scriptarr. "
                    f"{'The stack responded.' if status_payload.get('ok') else 'The stack status is currently degraded.'}"
                    f"{f' Oracle is using {runtime.provider}.' if runtime.enabled else ' Oracle is currently off.'}"
                ),
                "status": status_payload
            }

        if not runtime.enabled:
            return {
                "ok": True,
                "disabled": True,
                "reply": (
                    f"{active_config.noona_persona_name} is currently off. Add an OpenAI API key or switch to LocalAI "
                    "from Moon admin, then enable Oracle when you're ready."
                ),
                "status": status_payload
            }

        if runtime.provider == "openai" and not runtime.open_ai_api_key_configured:
            return {
                "ok": True,
                "disabled": True,
                "reply": f"{active_config.noona_persona_name} is configured for OpenAI, but the API key has not been set yet.",
                "status": status_payload
            }

        try:
            local_ai_available = runtime.provider != "localai" or await probe_local_ai_fn(runtime)
            if not local_ai_available:
                active_logger.warning(
                    "Oracle fell back because LocalAI was unavailable.",
                    extra={
                        "provider": runtime.provider,
                        "localAiBaseUrl": runtime.local_ai_base_url
                    }
                )
                return {
                    "ok": True,
                    "degraded": True,
                    "reply": _provider_fallback_reply(active_config.noona_persona_name, runtime.provider),
                    "status": status_payload,
                    "error": "LocalAI probe failed."
                }

            if isinstance(context, dict) and context:
                reply = await invoke_oracle_fn(runtime, active_config.noona_persona_name, message, context)
            else:
                reply = await invoke_oracle_fn(runtime, active_config.noona_persona_name, message)
            return {
                "ok": True,
                "reply": reply,
                "status": status_payload
            }
        except Exception as error:  # noqa: BLE001
            active_logger.error(
                "Oracle fell back after chat generation failed.",
                extra={
                    "provider": runtime.provider,
                    "error": str(error)
                }
            )
            return {
                "ok": True,
                "degraded": True,
                "reply": _provider_fallback_reply(active_config.noona_persona_name, runtime.provider),
                "status": status_payload,
                "error": str(error)
            }

    @app.post("/api/assist")
    async def assist(request: Request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}

        task = _normalize_string((body or {}).get("task"), "message")
        runtime = await resolve_oracle_runtime_settings(config=active_config, sage_client=active_sage_client)
        if not runtime.enabled:
            return {
                **_assist_fallback(task),
                "disabled": True,
                "reason": "Oracle is disabled."
            }
        if runtime.provider == "openai" and not runtime.open_ai_api_key_configured:
            return {
                **_assist_fallback(task),
                "disabled": True,
                "reason": "OpenAI API key is not configured."
            }

        try:
            if runtime.provider == "localai" and not await probe_local_ai_fn(runtime):
                return {
                    **_assist_fallback(task),
                    "reason": "LocalAI probe failed."
                }

            deterministic = _short_string((body or {}).get("deterministicContent"))
            prompt = _short_string((body or {}).get("prompt"), 1200)
            context = (body or {}).get("context") if isinstance((body or {}).get("context"), dict) else {}
            if task == "match-title":
                message = (
                    "Decide whether a user's guess should be accepted for a title trivia game. "
                    "Return JSON with keys matched(boolean), confidence(0-1), reason(short). "
                    f"Context: {context}. Guess prompt: {prompt}"
                )
            elif task == "message":
                message = (
                    "Append one concise, non-critical sentence to this deterministic Scriptarr Discord message. "
                    "Do not change facts, links, statuses, or moderation wording. "
                    f"Message: {deterministic}. Context: {context}"
                )
            else:
                message = (
                    "Help summarize this Scriptarr admin assist request in one concise sentence. "
                    f"Task: {task}. Prompt: {prompt}. Context: {context}"
                )

            text = await invoke_oracle_fn(runtime, active_config.noona_persona_name, message)
            return {
                "ok": True,
                "task": task,
                "text": _short_string(text, 500),
                "decision": None
            }
        except Exception as error:  # noqa: BLE001
            active_logger.warning(
                "Oracle assist degraded.",
                extra={
                    "task": task,
                    "provider": runtime.provider,
                    "error": str(error)
                }
            )
            return {
                **_assist_fallback(task),
                "error": str(error)
            }

    active_logger.info(
        "Oracle app initialized.",
        extra={
            "persona": active_config.noona_persona_name
        }
    )
    return app
