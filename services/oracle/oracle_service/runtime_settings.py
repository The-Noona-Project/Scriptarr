from __future__ import annotations

import asyncio
from dataclasses import dataclass

from .config import OracleConfig

ORACLE_SETTINGS_KEY = "oracle.settings"
ORACLE_OPENAI_API_KEY_SECRET = "oracle.openai.apiKey"


def _normalize_boolean(value: object, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return fallback


def _normalize_string(value: object, fallback: str = "") -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    return normalized or fallback


@dataclass(frozen=True)
class OracleRuntimeSettings:
    enabled: bool
    provider: str
    model: str
    temperature: float
    open_ai_api_key_configured: bool
    local_ai_profile_key: str
    local_ai_image_mode: str
    local_ai_custom_image: str
    local_ai_base_url: str
    local_ai_api_key: str
    open_ai_api_key: str
    api_key: str


async def resolve_oracle_runtime_settings(*, config: OracleConfig, sage_client) -> OracleRuntimeSettings:
    settings_response, secret_response = await asyncio.gather(
        sage_client.get_setting(ORACLE_SETTINGS_KEY),
        sage_client.get_secret(ORACLE_OPENAI_API_KEY_SECRET)
    )

    settings = settings_response.get("value") if isinstance(settings_response, dict) else {}
    settings = settings if isinstance(settings, dict) else {}
    open_ai_api_key = _normalize_string(secret_response.get("value") if isinstance(secret_response, dict) else None, config.open_ai_api_key)
    temperature = settings.get("temperature", config.temperature)
    try:
        parsed_temperature = float(str(temperature))
    except (TypeError, ValueError):
        parsed_temperature = config.temperature

    normalized_provider = _normalize_string(settings.get("provider"), "openai")
    provider = normalized_provider if normalized_provider in {"openai", "localai"} else "openai"

    return OracleRuntimeSettings(
        enabled=_normalize_boolean(settings.get("enabled"), False),
        provider=provider,
        model=_normalize_string(settings.get("model"), config.model),
        temperature=parsed_temperature,
        open_ai_api_key_configured=bool(open_ai_api_key),
        local_ai_profile_key=_normalize_string(settings.get("localAiProfileKey"), "nvidia"),
        local_ai_image_mode=_normalize_string(settings.get("localAiImageMode"), "preset"),
        local_ai_custom_image=_normalize_string(settings.get("localAiCustomImage"), ""),
        local_ai_base_url=config.local_ai_base_url,
        local_ai_api_key=config.local_ai_api_key,
        open_ai_api_key=open_ai_api_key,
        api_key=config.local_ai_api_key if provider == "localai" else open_ai_api_key
    )
