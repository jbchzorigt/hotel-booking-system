"""
Police-realm guest screening: hash, match, alert.

Flow (fire-and-forget from the check-in endpoint)
=================================================
    reception checks guest in
        └─ endpoint calls screening.schedule_check_in_screening(booking_id)
           and returns HTTP 200 IMMEDIATELY
              └─ background task (police-realm DB session):
                   1. load booking (+ room, hotel)
                   2. compare guest_registry_hash against active WantedPerson
                   3. on hit: INSERT PoliceMatch (idempotent) and publish an
                      alert to the Police Dashboard over Redis pub/sub ->
                      WebSocket

Security invariants
===================
*   Raw registry numbers never touch the database: ``compute_registry_hash``
    produces a keyed HMAC-SHA256 (salted with ``REGISTRY_HASH_SALT``), so
    the stored hashes are useless without the key — a plain SHA-256 of a
    10-character РД would be trivially brute-forceable.
*   Screening runs on the **police engine** (``police_runtime`` role); the
    app's own DB credentials cannot read ``wanted_persons`` at all.
*   Hotels are never notified of a match — the alert goes only to the
    police dashboard channel. Reception's check-in response is identical
    whether or not there was a hit (no timing/behaviour side channel,
    because screening is asynchronous).

Delivery architecture
=====================
Alerts are published to Redis pub/sub (``police:alerts``) instead of being
pushed straight into a local WebSocket dict: with N uvicorn workers the
dashboard's socket lives in ONE process while the check-in may be handled
by another. Every worker runs ``PoliceAlertBroadcaster.relay_forever()``
and forwards channel messages to whatever dashboard sockets it holds.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import AsyncContextManager, Callable, Protocol

from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import police_session
from app.core.redis import get_redis
from app.models.domain import (
    Booking,
    PoliceMatch,
    PoliceMatchStatus,
    Room,
    Tenant,
    WantedPerson,
)
from app.services.gov_service import normalize_registry_number

logger = logging.getLogger("app.police")

#: Redis pub/sub channel carrying serialized ``PoliceAlert`` documents.
POLICE_ALERT_CHANNEL = "police:alerts"


# ===========================================================================
# Registry hashing — the ONLY identity bridge between realms
# ===========================================================================
def compute_registry_hash(registry_number: str) -> str:
    """
    Keyed hash of a citizen registry number (HMAC-SHA256, hex).

    The same derivation is applied when storing
    ``Booking.guest_registry_hash`` and ``WantedPerson.registry_hash``,
    so matching is exact string equality — neither realm ever needs the
    other's raw documents.

    Raises:
        InvalidRegistryNumberError: malformed input (from normalisation).
    """
    normalized = normalize_registry_number(registry_number)
    key = settings.REGISTRY_HASH_SALT.get_secret_value().encode("utf-8")
    return hmac.new(key, normalized.encode("utf-8"), hashlib.sha256).hexdigest()


# ===========================================================================
# Alert payload + broadcaster
# ===========================================================================
@dataclass(frozen=True, slots=True)
class PoliceAlert:
    """Everything a dispatcher needs on one screen."""

    match_id: str
    matched_at: str            # ISO-8601 UTC
    wanted_full_name: str
    case_reference: str | None
    booking_code: str
    guest_full_name: str       # name given at check-in (may be an alias)
    hotel_name: str
    hotel_address: str | None
    hotel_maps_lat: float
    hotel_maps_lng: float
    room_number: str

    def to_json(self) -> str:
        return json.dumps(
            {"type": "POLICE_MATCH_ALERT", **asdict(self)},
            ensure_ascii=False,
            separators=(",", ":"),
        )


class SupportsSendText(Protocol):
    """Structural type for a WebSocket — keeps this module framework-free."""

    async def send_text(self, data: str) -> None: ...


class PoliceAlertBroadcaster:
    """
    Fan-out of police alerts: Redis pub/sub across workers, then WebSocket
    to every connected police dashboard in this process.

    Wiring (Phase 3 routes):
      * dashboard WS endpoint calls ``register`` / ``unregister``;
      * app lifespan starts ``relay_forever()`` as a long-lived task.
    """

    def __init__(self, redis: Redis | None = None) -> None:
        self._redis = redis if redis is not None else get_redis()
        self._local_sockets: set[SupportsSendText] = set()

    # -- publisher side (screening task) -------------------------------- #
    async def publish(self, alert: PoliceAlert) -> None:
        await self._redis.publish(POLICE_ALERT_CHANNEL, alert.to_json())

    # -- subscriber side (dashboard-holding worker) ---------------------- #
    def register(self, websocket: SupportsSendText) -> None:
        self._local_sockets.add(websocket)

    def unregister(self, websocket: SupportsSendText) -> None:
        self._local_sockets.discard(websocket)

    async def relay_forever(self) -> None:
        """Forward channel messages to local dashboard sockets. Runs for
        the life of the process; resilient to individual socket failures."""
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(POLICE_ALERT_CHANNEL)
        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                payload = message["data"]
                dead: list[SupportsSendText] = []
                for socket in self._local_sockets:
                    try:
                        await socket.send_text(payload)
                    except Exception:  # noqa: BLE001 — one dead socket
                        dead.append(socket)  # must not break the fan-out
                for socket in dead:
                    self.unregister(socket)
        finally:
            await pubsub.unsubscribe(POLICE_ALERT_CHANNEL)
            await pubsub.aclose()


# ===========================================================================
# Screening service
# ===========================================================================
#: Callable yielding a police-realm session with an open transaction.
PoliceSessionScope = Callable[[], AsyncContextManager[AsyncSession]]


class PoliceScreeningService:
    """Matches checked-in guests against the wanted-persons registry."""

    def __init__(
        self,
        session_scope: PoliceSessionScope = police_session,
        broadcaster: PoliceAlertBroadcaster | None = None,
    ) -> None:
        self._session_scope = session_scope
        self._broadcaster = broadcaster or PoliceAlertBroadcaster()
        # Strong references: bare create_task results are garbage-collectable,
        # which would silently kill in-flight screenings.
        self._inflight: set[asyncio.Task[None]] = set()

    # ------------------------------------------------------------------ #
    # Public API — called by the check-in endpoint
    # ------------------------------------------------------------------ #
    async def schedule_check_in_screening(self, booking_id: uuid.UUID) -> None:
        """
        Fire-and-forget screening. Returns immediately — the check-in
        response never waits on (or reveals anything about) the police
        realm. Failures are logged, never raised into the request path.

        ``async`` on purpose even though it never awaits: sync callables
        handed to Starlette's ``BackgroundTasks`` execute on a threadpool
        thread, where there is no running event loop for
        ``asyncio.create_task``. As a coroutine it runs on the loop itself.
        """
        task = asyncio.create_task(
            self._screen_safely(booking_id),
            name=f"police-screening:{booking_id}",
        )
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    async def _screen_safely(self, booking_id: uuid.UUID) -> None:
        try:
            await self.screen_booking(booking_id)
        except Exception:  # noqa: BLE001 — background task: log, never raise
            logger.exception("police screening failed for booking %s", booking_id)

    # ------------------------------------------------------------------ #
    # Core matching logic (also directly awaitable in tests)
    # ------------------------------------------------------------------ #
    async def screen_booking(self, booking_id: uuid.UUID) -> PoliceAlert | None:
        """
        Screen one booking. Returns the alert if a NEW match was recorded,
        None if there was no hit or the match already existed (idempotent
        under re-check-in and matcher re-runs).
        """
        async with self._session_scope() as session:
            row = (
                await session.execute(
                    select(Booking, Room, Tenant)
                    .join(Room, Booking.room_id == Room.id)
                    .join(Tenant, Booking.tenant_id == Tenant.id)
                    .where(Booking.id == booking_id)
                )
            ).one_or_none()
            if row is None:
                logger.warning("screening: booking %s not found", booking_id)
                return None
            booking, room, tenant = row

            if not booking.guest_registry_hash:
                return None  # walk-in without an ID document on file

            wanted = (
                await session.execute(
                    select(WantedPerson).where(
                        WantedPerson.registry_hash == booking.guest_registry_hash,
                        WantedPerson.is_active.is_(True),
                    )
                )
            ).scalar_one_or_none()
            if wanted is None:
                return None

            # Idempotent insert: the (wanted_person_id, booking_id) unique
            # index absorbs duplicate screenings without raising.
            matched_at = datetime.now(timezone.utc)
            match_id = (
                await session.execute(
                    pg_insert(PoliceMatch)
                    .values(
                        wanted_person_id=wanted.id,
                        booking_id=booking.id,
                        tenant_id=booking.tenant_id,
                        matched_at=matched_at,
                        status=PoliceMatchStatus.PENDING_REVIEW,
                    )
                    .on_conflict_do_nothing(
                        index_elements=["wanted_person_id", "booking_id"]
                    )
                    .returning(PoliceMatch.id)
                )
            ).scalar_one_or_none()
            if match_id is None:
                return None  # already matched previously — no duplicate alert

            alert = PoliceAlert(
                match_id=str(match_id),
                matched_at=matched_at.isoformat(),
                wanted_full_name=wanted.full_name,
                case_reference=wanted.case_reference,
                booking_code=booking.code,
                guest_full_name=booking.guest_full_name,
                hotel_name=tenant.name,
                hotel_address=tenant.address,
                hotel_maps_lat=float(tenant.maps_lat),
                hotel_maps_lng=float(tenant.maps_lng),
                room_number=room.room_number,
            )

        # Publish AFTER the transaction committed — a dispatcher clicking
        # the alert must find the PoliceMatch row already persisted.
        await self._broadcaster.publish(alert)
        logger.info("police match recorded for booking %s", booking_id)
        return alert
