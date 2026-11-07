"""Bound local generation concurrency without blocking status and health requests."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any


class InferenceGate:
    """Serialize local inference and reject callers whose short queue wait expires."""

    def __init__(self, concurrency: int = 1, wait_seconds: float = 5.0) -> None:
        self._semaphore = asyncio.Semaphore(max(1, concurrency))
        self._wait_seconds = wait_seconds

    async def invoke(self, operation: Callable[[], Awaitable[Any]]) -> Any:
        """Run one local generation, releasing its slot on success or cancellation."""
        try:
            await asyncio.wait_for(self._semaphore.acquire(), self._wait_seconds)
        except TimeoutError as error:
            raise RuntimeError("LocalAI is busy; retry shortly.") from error
        try:
            return await operation()
        finally:
            self._semaphore.release()
