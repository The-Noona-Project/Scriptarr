from __future__ import annotations

"""Environment-backed configuration for the Oracle FastAPI service."""

import os
from dataclasses import dataclass


def _parse_bool(value: str | None, fallback: bool = False) -> bool:
    normalized = str(value if value is not None else "").strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return fallback


def _normalize_url(value: str | None, fallback: str) -> str:
    # Callers join route fragments onto these bases, so keep them slash-stable.
    return str(value or fallback).rstrip("/")


def _parse_float(value: str | None, fallback: float) -> float:
    try:
        return float(str(value if value is not None else fallback))
    except (TypeError, ValueError):
        return fallback


def _parse_int(value: str | None, fallback: int) -> int:
    try:
        return int(str(value if value is not None else fallback))
    except (TypeError, ValueError):
        return fallback


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
    llm_timeout_seconds: float
    noona_persona_name: str
    local_ai_embedded_enabled: bool = False
    local_ai_bin: str = "local-ai"
    local_ai_args: str = "run --address 127.0.0.1:8080 --models-path /models --backends-path /data/backends --disable-web-ui"
    local_ai_models_dir: str = "/models"
    local_ai_data_dir: str = "/data"
    local_ai_backends_path: str = "/data/backends"
    local_ai_tmp_dir: str = "/data/tmp"
    local_ai_backend_assets_path: str = "/data/backend_data"
    local_ai_generated_content_path: str = "/data/generated"
    local_ai_upload_path: str = "/data/upload"
    local_ai_default_model_url: str = "huggingface://bartowski/Hermes-3-Llama-3.1-8B-GGUF/Hermes-3-Llama-3.1-8B-Q4_K_S.gguf"
    local_ai_alternate_model_urls: str = "huggingface://bartowski/Hermes-3-Llama-3.1-8B-GGUF/Hermes-3-Llama-3.1-8B-Q4_K_M.gguf,huggingface://Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"
    local_ai_backend: str = "llama-cpp"
    local_ai_context_size: int = 4096
    local_ai_gpu_layers: str = "auto"
    huggingface_token: str = ""


def resolve_oracle_config() -> OracleConfig:
    return OracleConfig(
        port=int(os.getenv("SCRIPTARR_ORACLE_PORT", "3001")),
        sage_base_url=_normalize_url(os.getenv("SCRIPTARR_SAGE_BASE_URL"), "http://127.0.0.1:3004"),
        # Preserve the legacy env fallback so existing dev and Docker setups still boot.
        service_token=os.getenv("SCRIPTARR_SERVICE_TOKEN") or os.getenv("SCRIPTARR_ORACLE_SERVICE_TOKEN") or "oracle-dev-token",
        open_ai_model=os.getenv("SCRIPTARR_ORACLE_OPENAI_MODEL", "gpt-4.1-mini"),
        open_ai_api_key=os.getenv("SCRIPTARR_OPENAI_API_KEY", ""),
        local_ai_base_url=_normalize_url(os.getenv("SCRIPTARR_LOCALAI_BASE_URL"), "http://127.0.0.1:8080/v1"),
        local_ai_api_key=os.getenv("SCRIPTARR_LOCALAI_API_KEY", "localai"),
        model=os.getenv("SCRIPTARR_ORACLE_MODEL") or os.getenv("SCRIPTARR_ORACLE_OPENAI_MODEL") or "gpt-4.1-mini",
        temperature=_parse_float(os.getenv("SCRIPTARR_ORACLE_TEMPERATURE"), 0.2),
        llm_timeout_seconds=_parse_float(os.getenv("SCRIPTARR_ORACLE_LLM_TIMEOUT_SECONDS"), 180.0),
        noona_persona_name=os.getenv("SCRIPTARR_NOONA_PERSONA_NAME", "Noona"),
        local_ai_embedded_enabled=_parse_bool(os.getenv("SCRIPTARR_LOCALAI_EMBEDDED"), False),
        local_ai_bin=os.getenv("SCRIPTARR_LOCALAI_BIN", "local-ai"),
        local_ai_args=os.getenv(
            "SCRIPTARR_LOCALAI_ARGS",
            "run --address 127.0.0.1:8080 --models-path /models --backends-path /data/backends --disable-web-ui"
        ),
        local_ai_models_dir=os.getenv("SCRIPTARR_LOCALAI_MODELS_DIR", "/models"),
        local_ai_data_dir=os.getenv("SCRIPTARR_LOCALAI_DATA_DIR", "/data"),
        local_ai_backends_path=os.getenv("SCRIPTARR_LOCALAI_BACKENDS_PATH", "/data/backends"),
        local_ai_tmp_dir=os.getenv("SCRIPTARR_LOCALAI_TMP_DIR", "/data/tmp"),
        local_ai_backend_assets_path=os.getenv("SCRIPTARR_LOCALAI_BACKEND_ASSETS_PATH", "/data/backend_data"),
        local_ai_generated_content_path=os.getenv("SCRIPTARR_LOCALAI_GENERATED_CONTENT_PATH", "/data/generated"),
        local_ai_upload_path=os.getenv("SCRIPTARR_LOCALAI_UPLOAD_PATH", "/data/upload"),
        local_ai_default_model_url=os.getenv(
            "SCRIPTARR_LOCALAI_DEFAULT_MODEL",
            "huggingface://bartowski/Hermes-3-Llama-3.1-8B-GGUF/Hermes-3-Llama-3.1-8B-Q4_K_S.gguf"
        ),
        local_ai_alternate_model_urls=os.getenv(
            "SCRIPTARR_LOCALAI_ALTERNATE_MODELS",
            "huggingface://bartowski/Hermes-3-Llama-3.1-8B-GGUF/Hermes-3-Llama-3.1-8B-Q4_K_M.gguf,"
            "huggingface://Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"
        ),
        local_ai_backend=os.getenv("SCRIPTARR_LOCALAI_BACKEND", "llama-cpp"),
        local_ai_context_size=_parse_int(os.getenv("SCRIPTARR_LOCALAI_CONTEXT_SIZE"), 4096),
        local_ai_gpu_layers=os.getenv("SCRIPTARR_LOCALAI_GPU_LAYERS", "auto"),
        huggingface_token=os.getenv("SCRIPTARR_HUGGINGFACE_TOKEN", "")
    )
