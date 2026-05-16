from __future__ import annotations

"""Read-only Scriptarr status projection for Oracle endpoints."""


async def read_scriptarr_status(sage_client) -> dict[str, object]:
    try:
        payload = await sage_client.get_bootstrap_status()
        payload = payload if isinstance(payload, dict) else {}
        return {
            "ok": True,
            "callbackUrl": payload.get("callbackUrl"),
            "localAi": payload.get("localAi"),
            "services": payload.get("services")
        }
    except Exception as error:  # noqa: BLE001
        # Health-style callers expect a degraded payload, not an exception bubble-up.
        return {
            "ok": False,
            "error": str(error)
        }
