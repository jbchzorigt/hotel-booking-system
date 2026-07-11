"""
Shared pytest fixtures + environment for the E2E suite.

Environment is configured here — BEFORE any ``app`` import — because
``app.core.config.settings`` is an eager singleton that reads the
environment at import time. Everything uses ``setdefault`` so a real
environment (CI, or a developer's shell) always wins over the local
fallbacks; nothing is hardcoded to one machine.

The suite is an ordered, stateful E2E scenario (not independent unit
tests): later phases assert on ledger totals produced by earlier phases,
and WebSocket flows must stay open across steps. Fixtures below provide the
shared TestClient, a cross-phase ``state`` bag, and a superuser
("owner") session that bypasses RLS for seeding/verification.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable

# --------------------------------------------------------------------------- #
# 1. Environment (must precede any `app` import)
# --------------------------------------------------------------------------- #
_ENV_DEFAULTS = {
    "APP_ENV": "local",
    "POSTGRES_HOST": "localhost",
    "POSTGRES_PORT": "55440",
    "POSTGRES_USER": "app_runtime",
    "POSTGRES_PASSWORD": "CHANGE_ME_IN_PRODUCTION",
    "POSTGRES_DB": "hotel_marketplace_test",
    "POSTGRES_POLICE_USER": "police_runtime",
    "POSTGRES_POLICE_PASSWORD": "CHANGE_ME_IN_PRODUCTION",
    # Keep the background janitor effectively dormant during the run so its
    # sweep never races the explicit janitor assertions (Phase G).
    "JANITOR_INTERVAL_SECONDS": "3600",
}
for _k, _v in _ENV_DEFAULTS.items():
    os.environ.setdefault(_k, _v)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# --------------------------------------------------------------------------- #
# 2. Superuser ("owner") connection — env-driven, bypasses RLS
# --------------------------------------------------------------------------- #
#: The owner is a superuser (schema owner) used ONLY by the test to seed and
#: verify while bypassing Row-Level Security. Distinct from the low-privilege
#: app_runtime role the application itself connects as.
_OWNER_USER = os.environ.get("TEST_DB_OWNER_USER", "hotel")
_OWNER_PASSWORD = os.environ.get(
    "TEST_DB_OWNER_PASSWORD", "PyJQHYDjvBWevPD46KVV25Z5OFdS055O"
)
OWNER_URL = os.environ.get(
    "TEST_DB_OWNER_URL",
    f"postgresql+asyncpg://{_OWNER_USER}:{_OWNER_PASSWORD}@"
    f"{os.environ['POSTGRES_HOST']}:{os.environ['POSTGRES_PORT']}/"
    f"{os.environ['POSTGRES_DB']}",
)


@asynccontextmanager
async def owner_session_ctx() -> AsyncIterator[AsyncSession]:
    """One superuser session on a fresh, loop-local engine (disposed on exit).

    Loop-local by design: async tests each get their own event loop, and
    asyncpg connections are loop-bound — creating + disposing the engine
    inside the caller's loop avoids cross-loop reuse.
    """
    engine = create_async_engine(OWNER_URL)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as s:
            yield s
    finally:
        await engine.dispose()


# --------------------------------------------------------------------------- #
# 3. Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="session")
def owner_session() -> Callable[[], Any]:
    """Factory for a superuser session context manager: ``async with
    owner_session() as s:``."""
    return owner_session_ctx


@pytest.fixture(scope="session")
def state() -> dict[str, Any]:
    """Mutable bag shared across the ordered E2E phases (ids, tokens, …)."""
    return {}


@pytest.fixture(scope="session")
def client() -> AsyncIterator[TestClient]:
    """Session-wide TestClient. Its lifespan starts the WebSocket pub/sub
    relay and the (dormant) janitor; a short pause lets the relay subscribe
    before the first event fires. Created lazily — after the async seed and
    escrow phase have released their loop-bound app resources."""
    import time

    from app.main import app

    with TestClient(app) as c:
        time.sleep(0.7)  # let the Redis pub/sub relay finish subscribing
        yield c
