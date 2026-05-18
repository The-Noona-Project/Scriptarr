from __future__ import annotations

"""Embedded LocalAI runtime manager for Oracle.

Oracle remains read-only for Scriptarr data. This module only owns Oracle's
private LocalAI process and GGUF model cache.
"""

import asyncio
import os
import shlex
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from .config import OracleConfig

GENERATION_PROBE_EXPECTED_TEXT = "scriptarr-ok"
GENERATION_PROBE_TTL_SECONDS = 60
GENERATION_PROBE_TIMEOUT_SECONDS = 45
GENERATION_PROBE_ATTEMPTS = 3
GENERATION_PROBE_RETRY_DELAY_SECONDS = 10
LOCALAI_READY_WAIT_SECONDS = 180
LOCALAI_READY_WAIT_INTERVAL_SECONDS = 2


class EmbeddedLocalAiError(RuntimeError):
    """Raised when a LocalAI model or runtime operation cannot complete."""


@dataclass(frozen=True)
class HuggingFaceModelRef:
    repo_id: str
    filename: str

    @property
    def local_name(self) -> str:
        return Path(self.filename).name

    @property
    def download_url(self) -> str:
        return f"https://huggingface.co/{self.repo_id}/resolve/main/{quote(self.filename)}"


def _normalize_string(value: object, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _safe_text(value: object, limit: int = 240) -> str:
    return _normalize_string(value)[:limit].strip()


def parse_huggingface_model(model_url: str) -> HuggingFaceModelRef:
    if not model_url.startswith("huggingface://"):
        raise EmbeddedLocalAiError("Model URL must use huggingface://owner/repo/file.gguf.")
    parts = [part for part in model_url.removeprefix("huggingface://").split("/") if part]
    if len(parts) < 3:
        raise EmbeddedLocalAiError("Model URL must include owner, repo, and filename.")
    repo_id = "/".join(parts[:2])
    filename = "/".join(parts[2:])
    if not filename.lower().endswith(".gguf"):
        raise EmbeddedLocalAiError("Model URL must point to a .gguf file.")
    return HuggingFaceModelRef(repo_id=repo_id, filename=filename)


def default_local_ai_model_name(config: OracleConfig) -> str:
    try:
        return parse_huggingface_model(config.local_ai_default_model_url).local_name
    except EmbeddedLocalAiError:
        return "Hermes-3-Llama-3.1-8B-Q4_K_S.gguf"


def normalize_local_ai_model_id(value: object, config: OracleConfig) -> str:
    model = _normalize_string(value)
    if not model or model == "gpt-4":
        return default_local_ai_model_name(config)
    if model.startswith("huggingface://"):
        return parse_huggingface_model(model).local_name
    return model


def _split_model_urls(config: OracleConfig) -> list[str]:
    urls = [config.local_ai_default_model_url]
    urls.extend(part.strip() for part in config.local_ai_alternate_model_urls.split(",") if part.strip())
    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            unique.append(url)
    return unique


def _has_nvidia_device() -> bool:
    return Path("/dev/nvidia0").exists()


def _resolve_gpu_layers(value: str) -> int:
    text = _normalize_string(value).lower()
    if not text or text == "auto":
        return 24 if _has_nvidia_device() else 0
    try:
        return max(0, int(text))
    except ValueError:
        return 0


def _yaml_string(value: object) -> str:
    return "\"" + str(value).replace("\\", "\\\\").replace("\"", "\\\"") + "\""


class EmbeddedLocalAiManager:
    """Manage Oracle's best-effort embedded LocalAI process and model cache."""

    def __init__(self, *, config: OracleConfig, logger) -> None:
        self.config = config
        self.logger = logger
        self.process: asyncio.subprocess.Process | None = None
        self.last_error = ""
        self.message = "Embedded LocalAI is disabled."
        self.updated_at = _now_iso()
        self._generation_probe: dict[str, Any] | None = None
        self._generation_probe_key = ""
        self._download_jobs: dict[str, dict[str, Any]] = {}
        self._download_tasks: dict[str, asyncio.Task] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.config.local_ai_embedded_enabled)

    @property
    def base_url(self) -> str:
        return self.config.local_ai_base_url.rstrip("/").removesuffix("/v1")

    def _mark(self, *, message: str = "", error: str = "") -> None:
        if message:
            self.message = message
        self.last_error = error
        self.updated_at = _now_iso()

    def _model_path(self, model_url: str | None = None) -> Path:
        selected = model_url or self.config.local_ai_default_model_url
        return Path(self.config.local_ai_models_dir) / parse_huggingface_model(selected).local_name

    def _model_url_for_id(self, model_id: str) -> str:
        for url in _split_model_urls(self.config):
            try:
                if parse_huggingface_model(url).local_name == model_id:
                    return url
            except EmbeddedLocalAiError:
                continue
        return self.config.local_ai_default_model_url

    def _write_model_config(self, model_url: str | None = None) -> str:
        model_ref = parse_huggingface_model(model_url or self.config.local_ai_default_model_url)
        models_dir = Path(self.config.local_ai_models_dir)
        models_dir.mkdir(parents=True, exist_ok=True)
        body = "\n".join([
            f"name: {_yaml_string(model_ref.local_name)}",
            f"backend: {_yaml_string(self.config.local_ai_backend)}",
            f"context_size: {self.config.local_ai_context_size}",
            f"gpu_layers: {_resolve_gpu_layers(self.config.local_ai_gpu_layers)}",
            "parameters:",
            f"  model: {_yaml_string(model_ref.local_name)}",
            "template:",
            "  chat: |",
            "    <|im_start|>system",
            "    {{.System}}<|im_end|>",
            "    {{range .Messages}}",
            "    <|im_start|>{{.Role}}",
            "    {{.Content}}<|im_end|>",
            "    {{end}}",
            "    <|im_start|>assistant",
            "  completion: |",
            "    {{.Input}}",
            "  reply_prefix: \"\"",
            "stopwords:",
            "  - \"<|im_end|>\"",
            ""
        ])
        config_path = models_dir / f"{model_ref.local_name}.yaml"
        if not config_path.exists() or config_path.read_text(encoding="utf-8") != body:
            config_path.write_text(body, encoding="utf-8")
        return str(config_path)

    def _runtime_env(self) -> dict[str, str]:
        return {
            **os.environ,
            "LOCALAI_MODELS_PATH": self.config.local_ai_models_dir,
            "MODELS_PATH": self.config.local_ai_models_dir,
            "LOCALAI_DATA_PATH": self.config.local_ai_data_dir,
            "LOCALAI_BACKENDS_PATH": self.config.local_ai_backends_path,
            "BACKENDS_PATH": self.config.local_ai_backends_path,
            "LOCALAI_BACKENDS_SYSTEM_PATH": self.config.local_ai_backends_path,
            "BACKEND_SYSTEM_PATH": self.config.local_ai_backends_path,
            "LOCALAI_BACKEND_ASSETS_PATH": self.config.local_ai_backend_assets_path,
            "BACKEND_ASSETS_PATH": self.config.local_ai_backend_assets_path,
            "LOCALAI_GENERATED_CONTENT_PATH": self.config.local_ai_generated_content_path,
            "LOCALAI_UPLOAD_PATH": self.config.local_ai_upload_path,
            "LOCALAI_CONFIG_PATH": self.config.local_ai_models_dir,
            "CONFIG_PATH": self.config.local_ai_models_dir,
            "TMPDIR": self.config.local_ai_tmp_dir,
            "TMP": self.config.local_ai_tmp_dir,
            "TEMP": self.config.local_ai_tmp_dir,
            "LOCALAI_DISABLE_WEBUI": "true"
        }

    async def start(self) -> None:
        if not self.enabled:
            self._mark(message="Embedded LocalAI is disabled.")
            return
        if self.process and self.process.returncode is None:
            return
        await self.prepare()
        args = [self.config.local_ai_bin, *shlex.split(self.config.local_ai_args)]
        try:
            self.process = await asyncio.create_subprocess_exec(
                *args,
                env=self._runtime_env(),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL
            )
            self._mark(message="Embedded LocalAI process started.")
        except Exception as error:  # noqa: BLE001
            self.process = None
            self._mark(message="Embedded LocalAI could not start.", error=str(error))
            self.logger.warning("Embedded LocalAI could not start.", extra={"error": str(error)})

    async def prepare(self) -> None:
        if not self.enabled:
            self._mark(message="Embedded LocalAI is disabled.")
            return
        Path(self.config.local_ai_models_dir).mkdir(parents=True, exist_ok=True)
        Path(self.config.local_ai_data_dir).mkdir(parents=True, exist_ok=True)
        Path(self.config.local_ai_backends_path).mkdir(parents=True, exist_ok=True)
        Path(self.config.local_ai_tmp_dir).mkdir(parents=True, exist_ok=True)
        Path(self.config.local_ai_backend_assets_path).mkdir(parents=True, exist_ok=True)
        Path(self.config.local_ai_generated_content_path).mkdir(parents=True, exist_ok=True)
        Path(self.config.local_ai_upload_path).mkdir(parents=True, exist_ok=True)
        self._write_model_config()
        self._mark(message="Embedded LocalAI cache prepared.")

    def backend_present(self) -> bool:
        backend = _normalize_string(self.config.local_ai_backend, "llama-cpp")
        backends_path = Path(self.config.local_ai_backends_path)
        if not backends_path.exists():
            return False
        candidates = [
            backends_path / backend,
            backends_path / f"{backend}.run"
        ]
        return any(candidate.exists() for candidate in candidates) or any(
            backend in path.name for path in backends_path.rglob("*")
        )

    async def ensure_backend(self) -> dict[str, Any]:
        backend = _normalize_string(self.config.local_ai_backend, "llama-cpp")
        if self.backend_present():
            return {"status": "present", "backend": backend, "path": self.config.local_ai_backends_path}
        args = [
            self.config.local_ai_bin,
            "backends",
            "install",
            backend,
            "--backends-path",
            self.config.local_ai_backends_path,
            "--backends-system-path",
            self.config.local_ai_backends_path
        ]
        try:
            process = await asyncio.create_subprocess_exec(
                *args,
                env=self._runtime_env(),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=600)
        except asyncio.TimeoutError as error:
            raise EmbeddedLocalAiError(f"Timed out installing LocalAI backend {backend}.") from error
        if process.returncode != 0:
            detail = _safe_text((stderr or stdout).decode("utf-8", "replace"), 800)
            raise EmbeddedLocalAiError(detail or f"LocalAI backend install failed for {backend}.")
        return {
            "status": "installed",
            "backend": backend,
            "path": self.config.local_ai_backends_path,
            "message": _safe_text((stdout or stderr).decode("utf-8", "replace"), 240)
        }

    async def stop(self) -> None:
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=8)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.process = None
        self._generation_probe = None
        self._mark(message="Embedded LocalAI process stopped.")

    def running(self) -> bool:
        return bool(self.process and self.process.returncode is None)

    def model_status(self, model_url: str | None = None) -> dict[str, Any]:
        selected = model_url or self.config.local_ai_default_model_url
        model_ref = parse_huggingface_model(selected)
        destination = Path(self.config.local_ai_models_dir) / model_ref.local_name
        bytes_on_disk = destination.stat().st_size if destination.exists() else 0
        return {
            "modelUrl": selected,
            "id": model_ref.local_name,
            "label": model_ref.local_name,
            "downloaded": bytes_on_disk > 0,
            "bytes": bytes_on_disk,
            "path": str(destination)
        }

    def model_options_payload(self, selected_model: str = "") -> dict[str, Any]:
        models = []
        for url in _split_model_urls(self.config):
            try:
                status = self.model_status(url)
            except EmbeddedLocalAiError:
                continue
            status["default"] = url == self.config.local_ai_default_model_url
            models.append(status)
        selected = normalize_local_ai_model_id(selected_model, self.config)
        if selected not in {entry["id"] for entry in models}:
            models.insert(0, {"id": selected, "label": selected, "downloaded": False, "default": False})
        return {
            "provider": "localai",
            "selectedModel": selected,
            "models": models,
            "source": "embedded",
            "ok": True,
            "error": None
        }

    async def ensure_model_file(self, model_url: str, *, huggingface_token: str = "", job_id: str | None = None) -> dict[str, Any]:
        model_ref = parse_huggingface_model(model_url)
        models_dir = Path(self.config.local_ai_models_dir)
        models_dir.mkdir(parents=True, exist_ok=True)
        destination = models_dir / model_ref.local_name
        if destination.exists() and destination.stat().st_size > 0:
            size = destination.stat().st_size
            if job_id:
                await self._update_job(job_id, bytesDownloaded=size, totalBytes=size, percent=100)
            return {"status": "present", "path": str(destination), "bytes": size}

        token = huggingface_token.strip() or self.config.huggingface_token.strip()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        temp_destination = destination.with_suffix(destination.suffix + ".part")
        resume_from = temp_destination.stat().st_size if temp_destination.exists() else 0
        if resume_from:
            headers["Range"] = f"bytes={resume_from}-"
        started = time.monotonic()
        async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
            async with client.stream("GET", model_ref.download_url, headers=headers) as response:
                if response.status_code >= 400:
                    raise EmbeddedLocalAiError(f"HuggingFace model download failed with status {response.status_code}.")
                mode = "ab" if resume_from and response.status_code == 206 else "wb"
                downloaded = resume_from if mode == "ab" else 0
                content_length = int(response.headers.get("content-length") or 0)
                total = content_length + downloaded if content_length else 0
                if job_id:
                    await self._update_download_progress(job_id, downloaded, total, started)
                with temp_destination.open(mode) as output:
                    async for chunk in response.aiter_bytes():
                        output.write(chunk)
                        downloaded += len(chunk)
                        if job_id:
                            await self._update_download_progress(job_id, downloaded, total, started)
        temp_destination.replace(destination)
        size = destination.stat().st_size
        if job_id:
            await self._update_download_progress(job_id, size, size, started)
        return {"status": "downloaded", "path": str(destination), "bytes": size}

    async def _update_download_progress(self, job_id: str, downloaded: int, total: int, started: float) -> None:
        elapsed = max(0.001, time.monotonic() - started)
        percent = int((downloaded / total) * 100) if total else 0
        await self._update_job(
            job_id,
            bytesDownloaded=max(0, int(downloaded)),
            totalBytes=max(0, int(total)),
            percent=max(0, min(100, percent)),
            speedBytesPerSecond=int(downloaded / elapsed)
        )

    async def _update_job(self, job_id: str, **changes: Any) -> None:
        job = self._download_jobs.get(job_id)
        if not job:
            return
        job.update(changes)
        job["updatedAt"] = _now_iso()
        tasks = job.get("tasks") or []
        if tasks:
            task = tasks[0]
            task.update({
                "status": job.get("status", task.get("status")),
                "percent": job.get("percent", task.get("percent", 0)),
                "message": job.get("message", task.get("message", "")),
                "updatedAt": job["updatedAt"]
            })

    def _new_job(self, action: str, model_url: str, requested_by: dict[str, Any] | None = None) -> dict[str, Any]:
        job_id = f"embedded_localai_{int(time.time() * 1000):x}"
        model_ref = parse_huggingface_model(model_url)
        created_at = _now_iso()
        return {
            "jobId": job_id,
            "kind": "localai-lifecycle",
            "ownerService": "scriptarr-oracle",
            "status": "queued",
            "label": "Install LocalAI" if action == "install" else "Start LocalAI" if action == "start" else "Remove LocalAI",
            "requestedBy": _normalize_string((requested_by or {}).get("discordUserId"), "moon-admin"),
            "requestedServices": ["scriptarr-oracle"],
            "progressPercent": 0,
            "payload": {
                "action": action,
                "modelUrl": model_url,
                "model": model_ref.local_name,
                "requestedByDiscordId": _normalize_string((requested_by or {}).get("discordUserId")),
                "requestedByUsername": _normalize_string((requested_by or {}).get("username"), "Admin")
            },
            "tasks": [{
                "taskId": f"{job_id}_model",
                "jobId": job_id,
                "taskKey": "model",
                "label": "Download model and verify generation" if action == "install" else "Verify LocalAI generation",
                "status": "queued",
                "message": "",
                "percent": 0,
                "sortOrder": 0,
                "createdAt": created_at,
                "updatedAt": created_at
            }],
            "result": {},
            "createdAt": created_at,
            "startedAt": created_at,
            "finishedAt": None,
            "updatedAt": created_at,
            "error": None
        }

    async def start_ensure_job(
        self,
        *,
        action: str = "install",
        model_url: str | None = None,
        huggingface_token: str = "",
        download_model: bool = True,
        requested_by: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        selected_model = model_url or self.config.local_ai_default_model_url
        if not selected_model.startswith("huggingface://"):
            selected_model = self._model_url_for_id(selected_model)
        job = self._new_job(action, selected_model, requested_by)
        self._download_jobs[job["jobId"]] = job
        task = asyncio.create_task(self._run_ensure_job(job["jobId"], action, selected_model, huggingface_token, download_model))
        self._download_tasks[job["jobId"]] = task
        return dict(job)

    async def _run_ensure_job(self, job_id: str, action: str, model_url: str, huggingface_token: str, download_model: bool) -> None:
        try:
            if action == "remove":
                await self.stop()
                await self._update_job(job_id, status="completed", progressPercent=100, percent=100, message="Embedded LocalAI stopped.")
                self._download_jobs[job_id]["finishedAt"] = _now_iso()
                return
            await self._update_job(job_id, status="running", progressPercent=5, percent=5, message="Preparing embedded LocalAI.")
            await self.prepare()
            if download_model:
                await self._update_job(job_id, message="Downloading selected GGUF model.", progressPercent=10, percent=10)
                download = await self.ensure_model_file(model_url, huggingface_token=huggingface_token, job_id=job_id)
            else:
                model = self.model_status(model_url)
                if not model["downloaded"]:
                    raise EmbeddedLocalAiError("The selected LocalAI model is not downloaded yet.")
                download = {"status": "present", "path": model["path"], "bytes": model["bytes"]}
            self._write_model_config(model_url)
            await self._update_job(job_id, message="Ensuring LocalAI llama-cpp backend.", progressPercent=82, percent=82)
            backend = await self.ensure_backend()
            await self._update_job(job_id, message="Starting embedded LocalAI.", progressPercent=85, percent=85)
            await self.start()
            await self._update_job(job_id, message="Waiting for embedded LocalAI API readiness.", progressPercent=88, percent=88)
            ready = await self.wait_until_ready()
            if not ready.get("ready"):
                raise EmbeddedLocalAiError(_safe_text(ready.get("error") or ready.get("reason"), 400) or "LocalAI API did not become ready.")
            await self._update_job(job_id, message="Verifying chat generation.", progressPercent=90, percent=90)
            probe = await self.verify_generation(model_url=model_url)
            if not probe.get("ready"):
                raise EmbeddedLocalAiError(_safe_text(probe.get("error") or probe.get("reason"), 400) or "LocalAI generation probe failed.")
            job = self._download_jobs[job_id]
            job["status"] = "completed"
            job["progressPercent"] = 100
            job["percent"] = 100
            job["finishedAt"] = _now_iso()
            job["result"] = {
                "model": self.model_status(model_url),
                "download": download,
                "backend": backend,
                "ready": probe
            }
            await self._update_job(job_id, message="Embedded LocalAI model is ready.")
        except Exception as error:  # noqa: BLE001
            job = self._download_jobs[job_id]
            job["status"] = "failed"
            job["error"] = str(error)
            job["finishedAt"] = _now_iso()
            job["result"] = {"error": str(error)}
            await self._update_job(job_id, message=str(error))
            self._mark(message="Embedded LocalAI action failed.", error=str(error))
        finally:
            self._download_tasks.pop(job_id, None)

    def latest_job(self) -> dict[str, Any] | None:
        if not self._download_jobs:
            return None
        return sorted(self._download_jobs.values(), key=lambda job: job.get("updatedAt", ""), reverse=True)[0]

    async def check_ready(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.base_url}/readyz")
            return {"status": "ready" if response.status_code < 500 else "not_ready", "statusCode": response.status_code}
        except Exception as error:  # noqa: BLE001
            return {"status": "not_ready", "error": _safe_text(error)}

    async def wait_until_ready(self, *, timeout_seconds: int = LOCALAI_READY_WAIT_SECONDS) -> dict[str, Any]:
        started = time.monotonic()
        last: dict[str, Any] = {"status": "not_ready", "reason": "not_checked"}
        while time.monotonic() - started < timeout_seconds:
            last = await self.check_ready()
            if last.get("status") == "ready":
                return {
                    **last,
                    "ready": True,
                    "latencyMs": int((time.monotonic() - started) * 1000)
                }
            await asyncio.sleep(LOCALAI_READY_WAIT_INTERVAL_SECONDS)
        return {
            **last,
            "ready": False,
            "latencyMs": int((time.monotonic() - started) * 1000),
            "reason": last.get("error") or last.get("reason") or "ready_timeout"
        }

    async def probe_generation(self, *, force: bool = False, model_url: str | None = None) -> dict[str, Any]:
        selected = model_url or self.config.local_ai_default_model_url
        model_name = parse_huggingface_model(selected).local_name
        cache_key = "|".join([self.base_url, model_name, self.config.local_ai_models_dir])
        if not force and self._generation_probe and self._generation_probe_key == cache_key:
            checked_at = self._generation_probe.get("_checked_monotonic", 0)
            if time.monotonic() - checked_at < GENERATION_PROBE_TTL_SECONDS:
                return {key: value for key, value in self._generation_probe.items() if not key.startswith("_")}

        payload = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": "Reply with exactly scriptarr-ok."},
                {"role": "user", "content": "generation readiness probe"}
            ],
            "temperature": 0
        }
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=GENERATION_PROBE_TIMEOUT_SECONDS) as client:
                response = await client.post(f"{self.base_url}/v1/chat/completions", json=payload)
            latency_ms = int((time.monotonic() - started) * 1000)
            body = response.json()
            content = ""
            choices = body.get("choices") if isinstance(body, dict) else []
            if choices and isinstance(choices[0], dict):
                content = _normalize_string((choices[0].get("message") or {}).get("content"))
            ready = response.status_code < 500 and bool(content)
            result = {
                "ready": ready,
                "status": "ready" if ready else "not_ready",
                "model": model_name,
                "backend": self.config.local_ai_backend,
                "expectedText": GENERATION_PROBE_EXPECTED_TEXT,
                "expectedTextPresent": GENERATION_PROBE_EXPECTED_TEXT in content.lower(),
                "latencyMs": latency_ms,
                "statusCode": response.status_code,
                "reason": "generated" if ready else "empty_completion",
                "sample": _safe_text(content, 160),
                "checkedAt": _now_iso()
            }
        except Exception as error:  # noqa: BLE001
            result = {
                "ready": False,
                "status": "not_ready",
                "model": model_name,
                "backend": self.config.local_ai_backend,
                "expectedText": GENERATION_PROBE_EXPECTED_TEXT,
                "expectedTextPresent": False,
                "reason": "generation_error",
                "error": _safe_text(error),
                "checkedAt": _now_iso()
            }
        if result.get("ready"):
            self._mark(message="Embedded LocalAI model is ready.", error="")
        self._generation_probe = {**result, "_checked_monotonic": time.monotonic()}
        self._generation_probe_key = cache_key
        return result

    async def verify_generation(
        self,
        *,
        model_url: str | None = None,
        attempts: int = GENERATION_PROBE_ATTEMPTS,
        delay_seconds: int = GENERATION_PROBE_RETRY_DELAY_SECONDS
    ) -> dict[str, Any]:
        """Probe generation with retries for first-load backend/model warmup."""

        last: dict[str, Any] = {
            "ready": False,
            "status": "not_ready",
            "reason": "not_checked"
        }
        for attempt in range(1, max(1, attempts) + 1):
            last = await self.probe_generation(force=True, model_url=model_url)
            last = {**last, "attempt": attempt, "attempts": max(1, attempts)}
            if last.get("ready"):
                return last
            if attempt < max(1, attempts):
                await asyncio.sleep(delay_seconds)
        return last

    async def status(self) -> dict[str, Any]:
        if self.enabled and not self.running():
            await self.prepare()
        model = self.model_status(self.config.local_ai_default_model_url)
        probe = await self.probe_generation() if self.enabled and model["downloaded"] and self.running() else {
            "ready": False,
            "status": "not_ready",
            "reason": "model_missing" if not model["downloaded"] else "runtime_not_running",
            "model": model["id"]
        }
        return {
            "embedded": True,
            "phase": "idle",
            "installed": bool(model["downloaded"]),
            "running": self.running(),
            "ready": bool(probe.get("ready")),
            "message": self.message,
            "lastError": self.last_error,
            "updatedAt": self.updated_at,
            "configuredImage": "embedded-oracle-localai",
            "configuredProfile": {"key": "nvidia" if _has_nvidia_device() else "cpu", "image": "embedded-oracle-localai"},
            "detectedProfile": {
                "key": "nvidia" if _has_nvidia_device() else "cpu",
                "detectedVendor": "nvidia" if _has_nvidia_device() else "cpu",
                "detectedDetails": ["nvidia-visible"] if _has_nvidia_device() else []
            },
            "profiles": [
                {"key": "nvidia", "image": "embedded-oracle-localai", "reason": "Embedded Oracle LocalAI with NVIDIA runtime."},
                {"key": "cpu", "image": "embedded-oracle-localai", "reason": "Embedded Oracle LocalAI without GPU runtime."}
            ],
            "containerName": "scriptarr-oracle",
            "model": model,
            "generationProbe": probe,
            "job": self.latest_job(),
            "models": self.model_options_payload(model["id"])["models"]
        }
