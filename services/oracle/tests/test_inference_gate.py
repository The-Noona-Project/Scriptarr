"""Concurrency and cancellation checks for local inference admission."""

import asyncio

import pytest

from oracle_service.inference_gate import InferenceGate


def test_busy_call_does_not_start_a_second_generation():
    async def scenario():
        gate = InferenceGate(1, wait_seconds=0.02)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def slow():
            entered.set()
            await release.wait()
            return "first"

        task = asyncio.create_task(gate.invoke(slow))
        await entered.wait()
        with pytest.raises(RuntimeError, match="busy"):
            await gate.invoke(lambda: asyncio.sleep(0))
        release.set()
        assert await task == "first"
        assert await gate.invoke(lambda: asyncio.sleep(0, result="next")) == "next"

    asyncio.run(scenario())


def test_cancellation_releases_the_generation_slot():
    async def scenario():
        gate = InferenceGate(1, wait_seconds=0.02)
        entered = asyncio.Event()

        async def slow():
            entered.set()
            await asyncio.sleep(60)

        task = asyncio.create_task(gate.invoke(slow))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert await gate.invoke(lambda: asyncio.sleep(0, result="recovered")) == "recovered"

    asyncio.run(scenario())
