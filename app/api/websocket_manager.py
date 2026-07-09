"""
WebSocket topic manager: Redis pub/sub -> connected dashboards.

Topology
========
Publishers (any worker, any process — including background tasks) write
JSON documents to Redis channels. Every web worker runs ONE relay task
(``manager.relay_forever()``, started from the app lifespan) that
subscribes to all topic patterns and forwards each message to the local
sockets registered on that exact topic. A dashboard connected to worker A
therefore receives events produced on worker B — no sticky sessions.

Topics
======
    police:alerts                     police dashboards (all of them)
    ws:tenant:{tenant_id}:reception   one hotel's reception screens
    ws:restaurant:{id}:orders         one restaurant owner's order screen

Authorization
=============
The JWT rides in as ``?token=…``. Each endpoint derives the topic from
the *token's* scope ids — never from client-supplied parameters — so a
reception token for hotel A physically cannot subscribe to hotel B.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from redis.asyncio import Redis

from app.core.redis import get_redis
from app.dependencies.auth import AuthContext, authenticate_ws_token
from app.models.domain import UserRole
from app.services.police_service import POLICE_ALERT_CHANNEL

logger = logging.getLogger("app.ws")


# ---------------------------------------------------------------------------
# Topic naming — single source of truth, used by publishers and subscribers
# ---------------------------------------------------------------------------
def reception_topic(tenant_id: Any) -> str:
    return f"ws:tenant:{tenant_id}:reception"


def restaurant_topic(restaurant_id: Any) -> str:
    return f"ws:restaurant:{restaurant_id}:orders"


#: Patterns the relay subscribes to. ``police:alerts`` is the Phase 2
#: channel the screening service already publishes to — reused verbatim.
_SUBSCRIBE_PATTERNS = (POLICE_ALERT_CHANNEL, "ws:*")


class WebSocketTopicManager:
    """Maps topic strings to the WebSockets connected in THIS process."""

    def __init__(self, redis: Redis | None = None) -> None:
        self._redis = redis if redis is not None else get_redis()
        self._topics: dict[str, set[WebSocket]] = {}

    # ------------------------------------------------------------------ #
    # Connection registry (called by the WS endpoints below)
    # ------------------------------------------------------------------ #
    async def connect(self, websocket: WebSocket, topic: str) -> None:
        await websocket.accept()
        self._topics.setdefault(topic, set()).add(websocket)
        logger.info("ws connected topic=%s (local=%d)", topic,
                    len(self._topics[topic]))

    def disconnect(self, websocket: WebSocket, topic: str) -> None:
        sockets = self._topics.get(topic)
        if sockets is not None:
            sockets.discard(websocket)
            if not sockets:
                del self._topics[topic]

    # ------------------------------------------------------------------ #
    # Publishing (used by routers/services; crosses worker boundaries)
    # ------------------------------------------------------------------ #
    async def publish(self, topic: str, payload: dict[str, Any]) -> None:
        await self._redis.publish(
            topic, json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        )

    # ------------------------------------------------------------------ #
    # Relay: Redis channel -> local sockets. One task per worker process.
    # ------------------------------------------------------------------ #
    async def relay_forever(self) -> None:
        """Runs for the process lifetime; started from the app lifespan.
        Reconnects with backoff if the Redis subscription drops."""
        while True:
            try:
                await self._relay_once()
            except asyncio.CancelledError:
                raise  # normal shutdown path
            except Exception:  # noqa: BLE001 — must survive redis blips
                logger.exception("ws relay lost Redis subscription; retrying")
                await asyncio.sleep(2.0)

    async def _relay_once(self) -> None:
        pubsub = self._redis.pubsub()
        await pubsub.psubscribe(*_SUBSCRIBE_PATTERNS)
        try:
            async for message in pubsub.listen():
                if message.get("type") not in ("message", "pmessage"):
                    continue
                await self._fan_out(str(message["channel"]),
                                    str(message["data"]))
        finally:
            await pubsub.punsubscribe(*_SUBSCRIBE_PATTERNS)
            await pubsub.aclose()

    async def _fan_out(self, topic: str, payload: str) -> None:
        dead: list[WebSocket] = []
        for socket in self._topics.get(topic, ()):
            try:
                await socket.send_text(payload)
            except Exception:  # noqa: BLE001 — one dead socket must not
                dead.append(socket)  # break delivery to the others
        for socket in dead:
            self.disconnect(socket, topic)


#: Process-wide singleton — routers publish through it, lifespan runs it.
manager = WebSocketTopicManager()


# ---------------------------------------------------------------------------
# WebSocket endpoints
# ---------------------------------------------------------------------------
ws_router = APIRouter(tags=["websockets"])

_RECEPTION_WS_ROLES = frozenset(
    {UserRole.RECEPTION.value, UserRole.MANAGER.value, UserRole.HOTEL_ADMIN.value}
)


async def _keep_open(websocket: WebSocket, topic: str) -> None:
    """Park the connection: consume (and ignore) client frames until the
    peer disconnects. All server->client traffic flows via the relay."""
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket, topic)


async def _reject(websocket: WebSocket) -> None:
    await websocket.close(code=status.WS_1008_POLICY_VIOLATION)


@ws_router.websocket("/ws/police/alerts")
async def police_alerts_ws(websocket: WebSocket) -> None:
    """Police dashboard feed — realm-gated, all hotels, all matches."""
    ctx: AuthContext | None = authenticate_ws_token(
        websocket.query_params.get("token")
    )
    if ctx is None or ctx.realm != "police":
        await _reject(websocket)
        return
    await manager.connect(websocket, POLICE_ALERT_CHANNEL)
    await _keep_open(websocket, POLICE_ALERT_CHANNEL)


@ws_router.websocket("/ws/reception")
async def reception_ws(websocket: WebSocket) -> None:
    """Reception screen feed — minibar reports, (later) new bookings.
    Topic derives from the token's tenant_id, never from the client."""
    ctx = authenticate_ws_token(websocket.query_params.get("token"))
    if ctx is None or ctx.realm != "app" or ctx.role not in _RECEPTION_WS_ROLES:
        await _reject(websocket)
        return
    topic = reception_topic(ctx.tenant_id)
    await manager.connect(websocket, topic)
    await _keep_open(websocket, topic)


@ws_router.websocket("/ws/restaurant/orders")
async def restaurant_orders_ws(websocket: WebSocket) -> None:
    """Restaurant owner feed — incoming food orders (wired in Phase 4)."""
    ctx = authenticate_ws_token(websocket.query_params.get("token"))
    if (
        ctx is None
        or ctx.realm != "app"
        or ctx.role != UserRole.RESTAURANT_OWNER.value
    ):
        await _reject(websocket)
        return
    topic = restaurant_topic(ctx.restaurant_id)
    await manager.connect(websocket, topic)
    await _keep_open(websocket, topic)
