from __future__ import annotations

import os
from dataclasses import dataclass


def _normalize_url(value: str | None, fallback: str) -> str:
    return str(value or fallback).rstrip("/")


@dataclass(frozen=True)
class OracleConfig:
    port: int
    sage_base_url: str
    service_token: str
    open_ai_model: str
    open_ai_api_key: str
    local_ai_base_url: str
    local_ai_api_key: str
    model: str
    temperature: float
    noona_persona_name: str


def resolve_oracle_config() -> OracleConfig:
    return OracleConfig(
        port=int(os.getenv("SCRIPTARR_ORACLE_PORT", "3001")),
        sage_base_url=_normalize_url(os.getenv("SCRIPTARR_SAGE_BASE_URL"), "http://127.0.0.1:3004"),
        service_token=os.getenv("SCRIPTARR_SERVICE_TOKEN") or os.getenv("SCRIPTARR_ORACLE_SERVICE_TOKEN") or "oracle-dev-token",
        open_ai_model=os.getenv("SCRIPTARR_ORACLE_OPENAI_MODEL", "gpt-4.1-mini"),
        open_ai_api_key=os.getenv("SCRIPTARR_OPENAI_API_KEY", ""),
        local_ai_base_url=_normalize_url(os.getenv("SCRIPTARR_LOCALAI_BASE_URL"), "http://127.0.0.1:8080/v1"),
        local_ai_api_key=os.getenv("SCRIPTARR_LOCALAI_API_KEY", "localai"),
        model=os.getenv("SCRIPTARR_ORACLE_MODEL") or os.getenv("SCRIPTARR_ORACLE_OPENAI_MODEL") or "gpt-4.1-mini",
        temperature=float(os.getenv("SCRIPTARR_ORACLE_TEMPERATURE", "0.2")),
        noona_persona_name=os.getenv("SCRIPTARR_NOONA_PERSONA_NAME", "Noona")
    )
