"""
Janitor: periodic sweep of abandoned (never-paid) checkouts.

Why it must exist: ``POST /book`` inserts a PENDING booking *before*
payment, and that row participates in the GiST no-overlap constraint —
an abandoned checkout therefore blocks the room's dates. This sweep
cancels PENDING/NOT_FUNDED bookings (and PLACED/NOT_FUNDED food orders)
older than ``PENDING_PAYMENT_TTL_MINUTES``, releasing the dates.

Safety properties
=================
*   **Money-safe by predicate**: the WHERE clause only ever matches rows
    whose escrow is ``NOT_FUNDED`` — a row that holds guest money can
    never be swept, no matter how old.
*   **Single sweeper across N workers**: every worker runs the loop, but
    ``pg_try_advisory_xact_lock`` lets exactly one perform each sweep;
    the rest skip that tick. No scheduler infrastructure needed.
*   **Cutoff computed in the DATABASE** (``now() - interval``), so app
    hosts with skewed clocks cannot sweep too eagerly.
*   The loop is crash-proof: one failed sweep logs and waits for the
    next tick; it never takes the worker down.
"""

from __future__ import annotations

import asyncio
import logging
from typing import AsyncContextManager, Callable

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import platform_session
from app.models.domain import Booking, BookingStatus, EscrowStatus, FoodOrder
from app.models.domain import FoodOrderStatus

logger = logging.getLogger("app.janitor")

#: Advisory lock key for the sweep (arbitrary but stable 64-bit int).
_SWEEP_LOCK_KEY = 0x4A414E31544F52  # "JAN1TOR"

SessionScope = Callable[[], AsyncContextManager[AsyncSession]]


class JanitorService:
    """Owns the sweep logic; ``run_forever`` is started from the lifespan."""

    def __init__(
        self,
        session_scope: SessionScope = platform_session,
        *,
        interval_seconds: int | None = None,
        ttl_minutes: int | None = None,
    ) -> None:
        self._session_scope = session_scope
        self._interval = interval_seconds or settings.JANITOR_INTERVAL_SECONDS
        self._ttl_minutes = ttl_minutes or settings.PENDING_PAYMENT_TTL_MINUTES

    async def run_forever(self) -> None:
        """One sweep per interval, for the life of the worker process."""
        logger.info(
            "janitor started (every %ss, ttl %smin)",
            self._interval,
            self._ttl_minutes,
        )
        while True:
            try:
                result = await self.sweep_once()
                if result["bookings_cancelled"] or result["orders_cancelled"]:
                    logger.info("janitor sweep: %s", result)
            except asyncio.CancelledError:
                raise  # normal shutdown
            except Exception:  # noqa: BLE001 — the loop must survive anything
                logger.exception("janitor sweep failed; retrying next tick")
            await asyncio.sleep(self._interval)

    async def sweep_once(self) -> dict[str, int | bool]:
        """
        Cancel expired unpaid checkouts. Safe to call concurrently from any
        number of workers — the advisory lock elects one sweeper per tick.
        """
        async with self._session_scope() as session:
            got_lock: bool = (
                await session.execute(
                    select(func.pg_try_advisory_xact_lock(_SWEEP_LOCK_KEY))
                )
            ).scalar_one()
            if not got_lock:
                return {"skipped": True, "bookings_cancelled": 0,
                        "orders_cancelled": 0}

            cutoff = text(
                f"now() - interval '{int(self._ttl_minutes)} minutes'"
            )

            expired_bookings = (
                await session.execute(
                    update(Booking)
                    .where(
                        Booking.status == BookingStatus.PENDING,
                        Booking.escrow_status == EscrowStatus.NOT_FUNDED,
                        Booking.created_at < cutoff,
                    )
                    .values(status=BookingStatus.CANCELLED)
                    .returning(Booking.code)
                )
            ).scalars().all()

            expired_orders = (
                await session.execute(
                    update(FoodOrder)
                    .where(
                        FoodOrder.status == FoodOrderStatus.PLACED,
                        FoodOrder.escrow_status == EscrowStatus.NOT_FUNDED,
                        FoodOrder.created_at < cutoff,
                    )
                    .values(status=FoodOrderStatus.CANCELLED)
                    .returning(FoodOrder.id)
                )
            ).scalars().all()

            if expired_bookings:
                logger.info(
                    "cancelled expired unpaid bookings: %s",
                    ", ".join(expired_bookings),
                )
            return {
                "skipped": False,
                "bookings_cancelled": len(expired_bookings),
                "orders_cancelled": len(expired_orders),
            }
