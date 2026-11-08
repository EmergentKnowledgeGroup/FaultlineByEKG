"""Waits: a coroutine that is awaited waits; one that is only created does not."""
import asyncio


async def awaited():
    await asyncio.sleep(1)
    return 1


async def not_awaited():
    asyncio.sleep(1)
    return 1
