"""
Async database engines, session factories and RLS context injection.

Two engines, two identities
===========================
*   **App engine** — connects as ``app_runtime``. Every Row-Level-Security
    policy applies; a session sees nothing until its identity GUCs are set.
*   **Police engine** — connects as ``police_runtime`` with credentials the
    app process does not need to know in production. Only this engine can
    reach ``wanted_persons`` / ``police_matches``.

RLS context (``set_config`` GUCs)
=================================
Policies in ``scripts/enable_rls.sql`` read ``app.user_role``,
``app.tenant_id``, ``app.restaurant_id`` and ``app.realm``. We set them with
``set_config(name, value, is_local => true)`` so they are **transaction
scoped**: with pooled connections (asyncpg / pgbouncer) one request's
identity can never bleed into the next request's transaction.

Because the values are transaction-local, the helpers below yield sessions
*inside an open transaction*; callers do their work and the context manager
commits (or rolls back) on exit.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import AsyncIterator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings

# ---------------------------------------------------------------------------
# Engines & factories
#
# All lazily built (and cached): importing this module has no side effects,
# which keeps unit tests and tooling free of a hard asyncpg/DB dependency.
# ---------------------------------------------------------------------------
@lru_cache(maxsize=1)
def get_engine() -> AsyncEngine:
    return create_async_engine(
        settings.DATABASE_URL,
        echo=settings.DB_ECHO,
        pool_size=settings.DB_POOL_SIZE,
        max_overflow=settings.DB_MAX_OVERFLOW,
        pool_recycle=settings.DB_POOL_RECYCLE_SECONDS,
        pool_pre_ping=True,
    )


@lru_cache(maxsize=1)
def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """App-realm factory. ``expire_on_commit=False`` — service methods
    return ORM objects/DTOs after their transaction commits; implicit
    lazy refreshes would then explode."""
    return async_sessionmaker(get_engine(), expire_on_commit=False)


@lru_cache(maxsize=1)
def get_police_engine() -> AsyncEngine:
    """
    Lazily-built police-realm engine.

    Lazy on purpose: web workers that never screen guests (e.g. a worker
    dedicated to public search) never open a police connection at all.
    Small pool — screening is a low-QPS background workload.
    """
    return create_async_engine(
        settings.POLICE_DATABASE_URL,
        echo=False,  # never echo police-realm SQL, whatever DB_ECHO says
        pool_size=5,
        max_overflow=5,
        pool_recycle=settings.DB_POOL_RECYCLE_SECONDS,
        pool_pre_ping=True,
    )


@lru_cache(maxsize=1)
def get_police_session_factory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_police_engine(), expire_on_commit=False)


# ---------------------------------------------------------------------------
# RLS context injection
# ---------------------------------------------------------------------------
async def set_rls_context(
    session: AsyncSession,
    *,
    realm: str = "app",
    user_role: str | None = None,
    tenant_id: uuid.UUID | None = None,
    restaurant_id: uuid.UUID | None = None,
) -> None:
    """
    Pin the current transaction to one identity.

    MUST be called inside an open transaction (``is_local => true`` is a
    no-op otherwise). Empty string == "unset": the RLS helper functions
    NULLIF it away, and an unset context matches no rows (fail closed).
    """
    gucs: dict[str, str] = {
        "app.realm": realm,
        "app.user_role": user_role or "",
        "app.tenant_id": str(tenant_id) if tenant_id else "",
        "app.restaurant_id": str(restaurant_id) if restaurant_id else "",
    }
    for name, value in gucs.items():
        await session.execute(
            text("SELECT set_config(:name, :value, true)"),
            {"name": name, "value": value},
        )


@asynccontextmanager
async def tenant_session(
    *,
    user_role: str,
    tenant_id: uuid.UUID | None = None,
    restaurant_id: uuid.UUID | None = None,
) -> AsyncIterator[AsyncSession]:
    """One transaction, scoped to a hotel/restaurant identity. Commits on exit."""
    async with get_session_factory()() as session:
        async with session.begin():
            await set_rls_context(
                session,
                realm="app",
                user_role=user_role,
                tenant_id=tenant_id,
                restaurant_id=restaurant_id,
            )
            yield session


@asynccontextmanager
async def platform_session() -> AsyncIterator[AsyncSession]:
    """
    One transaction under the platform's own identity (PLATFORM_ADMIN).

    Used by system workflows that legitimately cross tenant boundaries —
    escrow settlement, subscription billing, reconciliation. Never expose
    this to request handlers acting on behalf of hotel/restaurant users.
    """
    async with get_session_factory()() as session:
        async with session.begin():
            await set_rls_context(session, realm="app", user_role="PLATFORM_ADMIN")
            yield session


@asynccontextmanager
async def marketplace_session() -> AsyncIterator[AsyncSession]:
    """
    One transaction under the PUBLIC marketplace identity (realm
    'marketplace') — the RLS posture for unauthenticated guest reads.
    Policies expose only active hotels/rooms/restaurants and available
    menu items; bookings, users and wallets are invisible.

    Guest WRITE flows (booking, food orders) do NOT use this: they are
    platform-orchestrated transactions (the platform is the merchant of
    record in the escrow model) and run inside ``platform_session()``
    behind strictly-validating endpoints.
    """
    async with get_session_factory()() as session:
        async with session.begin():
            await set_rls_context(session, realm="marketplace", user_role="GUEST")
            yield session


@asynccontextmanager
async def police_session() -> AsyncIterator[AsyncSession]:
    """One transaction on the police engine, realm pinned to 'police'."""
    factory = get_police_session_factory()
    async with factory() as session:
        async with session.begin():
            await set_rls_context(session, realm="police", user_role="POLICE")
            yield session
