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


def create_app(
    *,
    logger: logging.Logger | None = None,
    config: OracleConfig | None = None,
    sage_client=None,
    probe_local_ai_fn=probe_local_ai,
    invoke_oracle_fn=invoke_oracle
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

    @app.post("/api/chat")
    async def chat(request: Request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        message = str((body or {}).get("message") or "").strip()
        if not message:
            active_logger.warning("Oracle chat request was missing a message.")
            return JSONResponse(status_code=400, content={"error": "message is required."})

        status_payload, runtime = await asyncio.gather(
            read_scriptarr_status(active_sage_client),
            resolve_oracle_runtime_settings(config=active_config, sage_client=active_sage_client)
        )
        if re.search(r"status|health|boot|callback", message, re.IGNORECASE):
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
                    "reply": f"{active_config.noona_persona_name} is in read-only fallback mode because LocalAI is unavailable right now.",
                    "status": status_payload,
                    "error": "LocalAI probe failed."
                }

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
                "reply": f"{active_config.noona_persona_name} is in read-only fallback mode because LocalAI is unavailable right now.",
                "status": status_payload,
                "error": str(error)
            }

    active_logger.info(
        "Oracle app initialized.",
        extra={
            "persona": active_config.noona_persona_name
        }
    )
    return app
