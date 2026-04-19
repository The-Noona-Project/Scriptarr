from __future__ import annotations


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
        return {
            "ok": False,
            "error": str(error)
        }
