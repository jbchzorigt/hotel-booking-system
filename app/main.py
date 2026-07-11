"""
Application entrypoint — wires routers, WebSocket relay and lifecycle.

Run locally:
    uvicorn app.main:app --reload
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.admin_router import router as admin_router
from app.api.auth_router import router as auth_router
from app.api.booking_router import router as booking_router
from app.api.cleaner_router import router as cleaner_router
from app.api.food_order_router import router as food_order_router
from app.api.manager_router import router as manager_router
from app.api.onboarding_router import admin_router as onboarding_admin_router
from app.api.onboarding_router import public_router as onboarding_public_router
from app.api.police_router import router as police_router
from app.api.public_router import guest_auth_router, payments_router
from app.api.public_router import router as public_router
from app.api.reception_router import router as reception_router
from app.api.restaurant_router import router as restaurant_router
from app.api.tenant_admin_router import router as tenant_admin_router
from app.api.websocket_manager import manager, ws_router
from app.core.config import settings
from app.core.redis import close_redis
from app.services.janitor_service import JanitorService

logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # One relay task per worker: Redis pub/sub -> local WebSockets.
    relay_task = asyncio.create_task(
        manager.relay_forever(), name="ws-pubsub-relay"
    )
    # Every worker runs the janitor loop; a PG advisory lock elects one
    # sweeper per tick, so this needs no external scheduler.
    janitor_task = asyncio.create_task(
        JanitorService().run_forever(), name="janitor-sweep"
    )
    logger.info("%s started (env=%s)", settings.APP_NAME, settings.APP_ENV)
    try:
        yield
    finally:
        for task in (relay_task, janitor_task):
            task.cancel()
        for task in (relay_task, janitor_task):
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await close_redis()


app = FastAPI(
    title="Hotel Booking Marketplace & Management SaaS",
    version="0.3.0",
    lifespan=lifespan,
    # Interactive docs are a reconnaissance gift in production.
    docs_url="/docs" if settings.APP_ENV != "production" else None,
    redoc_url=None,
    openapi_url=(
        f"{settings.API_V1_PREFIX}/openapi.json"
        if settings.APP_ENV != "production"
        else None
    ),
)

# ---------------------------------------------------------------------------
# CORS — explicit origin allowlist from settings (no wildcards; the config
# fail-fast guard additionally refuses non-https origins in production).
# ``Idempotency-Key`` must be an allowed header or the browser preflight
# rejects booking/food-order/payment requests even with valid origins.
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    max_age=600,  # cache preflights: one OPTIONS per endpoint per 10 min
)

app.include_router(auth_router, prefix=settings.API_V1_PREFIX)
app.include_router(booking_router, prefix=settings.API_V1_PREFIX)
app.include_router(food_order_router, prefix=settings.API_V1_PREFIX)
app.include_router(reception_router, prefix=settings.API_V1_PREFIX)
app.include_router(cleaner_router, prefix=settings.API_V1_PREFIX)
app.include_router(manager_router, prefix=settings.API_V1_PREFIX)
app.include_router(restaurant_router, prefix=settings.API_V1_PREFIX)
app.include_router(admin_router, prefix=settings.API_V1_PREFIX)
app.include_router(onboarding_public_router, prefix=settings.API_V1_PREFIX)
app.include_router(onboarding_admin_router, prefix=settings.API_V1_PREFIX)
app.include_router(tenant_admin_router, prefix=settings.API_V1_PREFIX)
app.include_router(police_router, prefix=settings.API_V1_PREFIX)
app.include_router(public_router, prefix=settings.API_V1_PREFIX)
app.include_router(payments_router, prefix=settings.API_V1_PREFIX)
app.include_router(guest_auth_router, prefix=settings.API_V1_PREFIX)
app.include_router(ws_router)  # WS paths are not API-versioned


@app.get("/healthz", tags=["ops"])
async def healthz() -> dict[str, str]:
    """Liveness probe — no dependencies touched."""
    return {"status": "ok", "env": settings.APP_ENV}
