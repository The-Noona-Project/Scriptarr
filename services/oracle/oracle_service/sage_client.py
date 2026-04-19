from __future__ import annotations

import json
from urllib.parse import quote

import httpx


class SageClient:
    def __init__(self, base_url: str, service_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {service_token}",
            "Content-Type": "application/json"
        }

    async def _request_json(self, path: str, method: str = "GET", body: object | None = None) -> tuple[bool, int, object | None]:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.request(
                method,
                f"{self._base_url}{path}",
                headers=self._headers,
                json=body
            )

        payload: object | None
        text = response.text
        if not text:
            payload = None
        else:
            try:
                payload = response.json()
            except json.JSONDecodeError:
                payload = {"raw": text}

        return response.is_success, response.status_code, payload

    async def get_setting(self, key: str) -> object | None:
        _ok, _status, payload = await self._request_json(
            f"/api/internal/vault/settings/{quote(key, safe='')}"
        )
        return payload

    async def get_secret(self, key: str) -> object | None:
        _ok, _status, payload = await self._request_json(
            f"/api/internal/vault/secrets/{quote(key, safe='')}"
        )
        return payload

    async def get_bootstrap_status(self) -> object:
        ok, status, payload = await self._request_json("/api/internal/warden/bootstrap")
        if not ok:
            error = payload["error"] if isinstance(payload, dict) and "error" in payload else f"Sage bootstrap request failed with {status}"
            raise RuntimeError(str(error))
        return payload
