"""
Process-wide async Redis client.

One connection pool per process (``redis.asyncio.Redis`` manages pooling
internally). ``decode_responses=True`` so every service works with ``str``
— we store JSON documents, never raw bytes.

Used for: payment idempotency keys, police alert pub/sub fan-out, and
(later phases) caching and rate limiting.
"""

from __future__ import annotations

from functools import lru_cache

from redis.asyncio import Redis

from app.core.config import settings


@lru_cache(maxsize=1)
def get_redis() -> Redis:
    """Return the shared Redis client (lazily created, cached per process)."""
    return Redis.from_url(
        settings.REDIS_URL,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
        health_check_interval=30,
    )


async def close_redis() -> None:
    """Graceful shutdown hook — call from the FastAPI lifespan handler."""
    if get_redis.cache_info().currsize:
        await get_redis().aclose()
        get_redis.cache_clear()
