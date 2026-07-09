"""
Split-payment escrow service (QPay / Card) with Redis idempotency.

Money flow
==========
1.  **Capture** (``pay_booking`` / ``pay_food_order``):
    guest pays via a gateway; funds move to the platform's escrow;
    the payable flips ``NOT_FUNDED -> HELD``. Guarded by a client-supplied
    ``Idempotency-Key`` so a double-submitted checkout can never charge
    twice.

2.  **Release** (``release_booking_escrow`` / ``release_food_order_escrow``):
    after the service is delivered (check-out / order delivered), the HELD
    amount is split:

        commission (5%)  -> PlatformAccount.balance  (+ ledger entry)
        remainder  (95%) -> Tenant.wallet_balance / Restaurant.wallet_balance

    the payable flips ``HELD -> RELEASED``.

Correctness properties
======================
*   **Idempotent capture** — Redis ``SET NX`` fences the key: concurrent
    duplicates get ``PaymentInProgressError`` (HTTP 409 at the API layer),
    later duplicates get the cached receipt back, byte-for-byte.
*   **Idempotent release** — driven by DB state: the payable row is locked
    with ``SELECT ... FOR UPDATE`` and must be ``HELD``; a second release
    attempt finds ``RELEASED`` and raises, it can never double-credit.
*   **No lost pennies** — commission is quantised half-up to the cent and
    the merchant gets ``total - commission`` (subtraction, not a second
    multiplication), so the two legs always sum to the charged total.
*   **Deadlock-free** — every transaction takes row locks in one global
    order: payable -> platform account -> merchant wallet.
*   **RLS-consistent** — settlement crosses tenant boundaries by design, so
    all work runs inside ``platform_session()`` (PLATFORM_ADMIN identity);
    hotel/restaurant request sessions can never move escrow funds.
"""

from __future__ import annotations

import enum
import json
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import AsyncContextManager, Callable, Protocol

from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import platform_session
from app.core.redis import get_redis
from app.models.domain import (
    Booking,
    EscrowStatus,
    FoodOrder,
    LedgerDirection,
    LedgerSourceType,
    MinibarConsumption,
    PlatformAccount,
    PlatformLedgerEntry,
    Restaurant,
    Tenant,
)

_CENT = Decimal("0.01")


# ===========================================================================
# Errors
# ===========================================================================
class PaymentError(Exception):
    """Base class for payment/escrow failures."""


class PaymentInProgressError(PaymentError):
    """Same Idempotency-Key is being processed right now (surface as 409)."""


class InvalidEscrowStateError(PaymentError):
    """The payable is not in the escrow state this operation requires."""


class PaymentDeclinedError(PaymentError):
    """The gateway declined the charge."""


class PayableNotFoundError(PaymentError):
    """No Booking/FoodOrder with the given id (or RLS hid it)."""


class PlatformAccountMissingError(PaymentError):
    """The singleton PlatformAccount row has not been seeded."""


# ===========================================================================
# Money math
# ===========================================================================
def split_amount(total: Decimal, rate: Decimal) -> tuple[Decimal, Decimal]:
    """
    Split ``total`` into ``(commission, merchant_share)``.

    Commission is rounded half-up to the cent; the merchant share is the
    exact remainder — the legs always reconcile to ``total``.
    """
    if total < 0:
        raise ValueError("total must be non-negative")
    commission = (total * rate).quantize(_CENT, rounding=ROUND_HALF_UP)
    return commission, total - commission


# ===========================================================================
# Payment gateways (QPay / Card) — ports & mock adapters
# ===========================================================================
class PaymentMethod(str, enum.Enum):
    QPAY = "QPAY"
    CARD = "CARD"


@dataclass(frozen=True, slots=True)
class GatewayCharge:
    transaction_id: str
    method: PaymentMethod


class PaymentGatewayPort(Protocol):
    async def charge(
        self, *, amount: Decimal, currency: str, reference: str
    ) -> GatewayCharge:
        """
        Charge the guest. ``reference`` doubles as the PSP-side idempotency
        key — real QPay/card processors deduplicate on it too, giving a
        second, independent layer of double-charge protection.

        Raises:
            PaymentDeclinedError: the PSP refused the charge.
        """
        ...


class MockQPayGateway:
    """Approves everything; transaction id is deterministic per reference."""

    async def charge(
        self, *, amount: Decimal, currency: str, reference: str
    ) -> GatewayCharge:
        return GatewayCharge(
            transaction_id=f"qpay-{uuid.uuid5(uuid.NAMESPACE_URL, reference)}",
            method=PaymentMethod.QPAY,
        )


class MockCardGateway:
    """Approves everything; transaction id is deterministic per reference."""

    async def charge(
        self, *, amount: Decimal, currency: str, reference: str
    ) -> GatewayCharge:
        return GatewayCharge(
            transaction_id=f"card-{uuid.uuid5(uuid.NAMESPACE_URL, reference)}",
            method=PaymentMethod.CARD,
        )


# ===========================================================================
# Idempotency guard (Redis)
# ===========================================================================
class IdempotencyGuard:
    """
    Redis-backed fence around a unit of work.

    Protocol:
        begin(key)  -> None            first time: key claimed, proceed
                    -> cached JSON     replay: return this, do NOT redo work
                    -> raises PaymentInProgressError  concurrent duplicate
        commit(key, result_json)       store the receipt for future replays
        abort(key)                     failure: free the key so the client
                                       may legitimately retry

    ``SET NX`` makes claim-if-absent atomic — two racing requests cannot
    both claim the key, which is the actual double-charge scenario.
    """

    _IN_PROGRESS = "__IN_PROGRESS__"

    def __init__(self, redis: Redis, *, scope: str, ttl_seconds: int) -> None:
        self._redis = redis
        self._scope = scope
        self._ttl = ttl_seconds

    def _key(self, key: str) -> str:
        return f"idem:{self._scope}:{key}"

    async def begin(self, key: str) -> str | None:
        claimed = await self._redis.set(
            self._key(key), self._IN_PROGRESS, nx=True, ex=self._ttl
        )
        if claimed:
            return None  # fresh key — caller does the real work
        existing = await self._redis.get(self._key(key))
        if existing is None or existing == self._IN_PROGRESS:
            raise PaymentInProgressError(
                "this Idempotency-Key is already being processed"
            )
        return existing  # completed earlier — cached receipt

    async def commit(self, key: str, result_json: str) -> None:
        await self._redis.set(self._key(key), result_json, ex=self._ttl)

    async def abort(self, key: str) -> None:
        await self._redis.delete(self._key(key))


# ===========================================================================
# Receipts / settlement DTOs
# ===========================================================================
@dataclass(frozen=True, slots=True)
class PaymentReceipt:
    """Returned on capture; JSON-serialisable for idempotent replays."""

    payable_type: str          # "booking" | "food_order"
    payable_id: str
    amount: str                # Decimal as string — exact
    currency: str
    method: str
    gateway_transaction_id: str
    escrow_status: str
    paid_at: str               # ISO-8601 UTC
    idempotency_key: str

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"))

    @classmethod
    def from_json(cls, raw: str) -> "PaymentReceipt":
        return cls(**json.loads(raw))


@dataclass(frozen=True, slots=True)
class EscrowSettlement:
    """Returned on release — the 5% / 95% split, exact."""

    payable_type: str
    payable_id: str
    total_amount: Decimal
    commission_amount: Decimal
    merchant_amount: Decimal
    merchant_type: str         # "tenant" | "restaurant"
    merchant_id: str
    settled_at: datetime


# ===========================================================================
# The service
# ===========================================================================
#: Callable returning an async context manager yielding a session with an
#: OPEN transaction and PLATFORM_ADMIN RLS context (see core.database).
SessionScope = Callable[[], AsyncContextManager[AsyncSession]]


class EscrowService:
    """Capture and settle escrowed marketplace payments."""

    def __init__(
        self,
        session_scope: SessionScope = platform_session,
        redis: Redis | None = None,
        gateways: dict[PaymentMethod, PaymentGatewayPort] | None = None,
    ) -> None:
        self._session_scope = session_scope
        self._redis = redis if redis is not None else get_redis()
        self._gateways: dict[PaymentMethod, PaymentGatewayPort] = gateways or {
            PaymentMethod.QPAY: MockQPayGateway(),
            PaymentMethod.CARD: MockCardGateway(),
        }
        self._guard = IdempotencyGuard(
            self._redis,
            scope="payment",
            ttl_seconds=settings.IDEMPOTENCY_TTL_SECONDS,
        )

    # ------------------------------------------------------------------ #
    # Capture — guest pays, funds become HELD
    # ------------------------------------------------------------------ #
    async def pay_booking(
        self,
        booking_id: uuid.UUID,
        *,
        method: PaymentMethod,
        idempotency_key: str,
    ) -> PaymentReceipt:
        return await self._capture(Booking, "booking", booking_id, method,
                                   idempotency_key)

    async def pay_food_order(
        self,
        food_order_id: uuid.UUID,
        *,
        method: PaymentMethod,
        idempotency_key: str,
    ) -> PaymentReceipt:
        return await self._capture(FoodOrder, "food_order", food_order_id,
                                   method, idempotency_key)

    async def _capture(
        self,
        model: type[Booking] | type[FoodOrder],
        payable_type: str,
        payable_id: uuid.UUID,
        method: PaymentMethod,
        idempotency_key: str,
    ) -> PaymentReceipt:
        if not idempotency_key or len(idempotency_key) < 8:
            raise PaymentError("Idempotency-Key header is required (min 8 chars)")

        # ---- Idempotency fence ---------------------------------------- #
        cached = await self._guard.begin(idempotency_key)
        if cached is not None:
            replay = PaymentReceipt.from_json(cached)
            if replay.payable_id != str(payable_id):
                # Same key reused for a DIFFERENT payment — client bug.
                raise PaymentError(
                    "Idempotency-Key was already used for another payment"
                )
            return replay

        try:
            async with self._session_scope() as session:
                payable = await session.get(
                    model, payable_id, with_for_update=True
                )
                if payable is None:
                    raise PayableNotFoundError(f"{payable_type} {payable_id}")
                if payable.escrow_status != EscrowStatus.NOT_FUNDED:
                    raise InvalidEscrowStateError(
                        f"cannot capture: escrow is {payable.escrow_status.value}"
                    )

                charge = await self._gateways[method].charge(
                    amount=payable.total_amount,
                    currency=settings.PLATFORM_CURRENCY,
                    reference=idempotency_key,
                )

                now = datetime.now(timezone.utc)
                payable.escrow_status = EscrowStatus.HELD
                payable.paid_at = now

                receipt = PaymentReceipt(
                    payable_type=payable_type,
                    payable_id=str(payable_id),
                    amount=str(payable.total_amount),
                    currency=settings.PLATFORM_CURRENCY,
                    method=method.value,
                    gateway_transaction_id=charge.transaction_id,
                    escrow_status=EscrowStatus.HELD.value,
                    paid_at=now.isoformat(),
                    idempotency_key=idempotency_key,
                )
            # Cache ONLY after the DB transaction committed: a crash between
            # charge and commit leaves the key free, and the PSP-side
            # reference dedup prevents a re-charge on retry.
            await self._guard.commit(idempotency_key, receipt.to_json())
            return receipt
        except BaseException:
            await self._guard.abort(idempotency_key)
            raise

    # ------------------------------------------------------------------ #
    # Minibar settlement — charge-and-split in one step (checkout time)
    # ------------------------------------------------------------------ #
    async def settle_minibar_charges(
        self,
        booking_id: uuid.UUID,
        *,
        method: PaymentMethod,
        idempotency_key: str,
    ) -> PaymentReceipt | None:
        """
        Charge the guest for all unsettled minibar consumptions of a
        booking and split immediately (5% platform / 95% hotel).

        Unlike room escrow there is no holding period — the goods are
        already consumed — so capture and release collapse into a single
        transaction. Returns None when nothing is owed.

        Idempotent on ``idempotency_key`` (checkout retries replay the
        receipt); rows also flip ``is_settled`` under ``FOR UPDATE``, so
        even a fresh key cannot re-charge settled consumptions.
        """
        cached = await self._guard.begin(idempotency_key)
        if cached is not None:
            return PaymentReceipt.from_json(cached)

        receipt: PaymentReceipt | None = None
        try:
            async with self._session_scope() as session:
                booking = await session.get(
                    Booking, booking_id, with_for_update=True
                )
                if booking is None:
                    raise PayableNotFoundError(f"booking {booking_id}")

                consumptions = (
                    await session.execute(
                        select(MinibarConsumption)
                        .where(
                            MinibarConsumption.booking_id == booking_id,
                            MinibarConsumption.is_settled.is_(False),
                        )
                        .with_for_update()
                    )
                ).scalars().all()

                if consumptions:
                    total = sum(
                        (c.unit_price * c.quantity for c in consumptions),
                        Decimal("0.00"),
                    )
                    charge = await self._gateways[method].charge(
                        amount=total,
                        currency=settings.PLATFORM_CURRENCY,
                        reference=idempotency_key,
                    )
                    commission, merchant_share = split_amount(
                        total, booking.commission_rate
                    )

                    platform = (
                        await session.execute(
                            select(PlatformAccount).with_for_update().limit(1)
                        )
                    ).scalar_one_or_none()
                    if platform is None:
                        raise PlatformAccountMissingError(
                            "seed the PlatformAccount row before settling"
                        )
                    platform.balance += commission
                    session.add(
                        PlatformLedgerEntry(
                            account_id=platform.id,
                            direction=LedgerDirection.CREDIT,
                            source_type=LedgerSourceType.MINIBAR_COMMISSION,
                            amount=commission,
                            balance_after=platform.balance,
                            booking_id=booking_id,
                            note=(
                                f"5% commission on minibar charges, "
                                f"booking {booking_id}"
                            ),
                        )
                    )

                    hotel = await session.get(
                        Tenant, booking.tenant_id, with_for_update=True
                    )
                    hotel.wallet_balance += merchant_share

                    now = datetime.now(timezone.utc)
                    for consumption in consumptions:
                        consumption.is_settled = True

                    receipt = PaymentReceipt(
                        payable_type="minibar",
                        payable_id=str(booking_id),
                        amount=str(total),
                        currency=settings.PLATFORM_CURRENCY,
                        method=method.value,
                        gateway_transaction_id=charge.transaction_id,
                        escrow_status=EscrowStatus.RELEASED.value,
                        paid_at=now.isoformat(),
                        idempotency_key=idempotency_key,
                    )

            if receipt is None:
                # Nothing owed: free the key so a later report + retry works.
                await self._guard.abort(idempotency_key)
                return None
            await self._guard.commit(idempotency_key, receipt.to_json())
            return receipt
        except BaseException:
            await self._guard.abort(idempotency_key)
            raise

    # ------------------------------------------------------------------ #
    # Release — 5% to platform, 95% to merchant
    # ------------------------------------------------------------------ #
    async def release_booking_escrow(
        self, booking_id: uuid.UUID
    ) -> EscrowSettlement:
        return await self._release(Booking, "booking", booking_id)

    async def release_food_order_escrow(
        self, food_order_id: uuid.UUID
    ) -> EscrowSettlement:
        return await self._release(FoodOrder, "food_order", food_order_id)

    async def _release(
        self,
        model: type[Booking] | type[FoodOrder],
        payable_type: str,
        payable_id: uuid.UUID,
    ) -> EscrowSettlement:
        async with self._session_scope() as session:
            # Lock order (global): payable -> platform account -> merchant.
            payable = await session.get(model, payable_id, with_for_update=True)
            if payable is None:
                raise PayableNotFoundError(f"{payable_type} {payable_id}")
            if payable.escrow_status != EscrowStatus.HELD:
                raise InvalidEscrowStateError(
                    f"cannot release: escrow is {payable.escrow_status.value}"
                )

            commission, merchant_share = split_amount(
                payable.total_amount, payable.commission_rate
            )
            # Persist the exact split on the payable (snapshot discipline).
            payable.commission_amount = commission

            # ---- 5% -> platform wallet + immutable ledger entry -------- #
            platform = (
                await session.execute(
                    select(PlatformAccount).with_for_update().limit(1)
                )
            ).scalar_one_or_none()
            if platform is None:
                raise PlatformAccountMissingError(
                    "seed the PlatformAccount row before settling payments"
                )
            platform.balance += commission

            is_booking = payable_type == "booking"
            session.add(
                PlatformLedgerEntry(
                    account_id=platform.id,
                    direction=LedgerDirection.CREDIT,
                    source_type=(
                        LedgerSourceType.BOOKING_COMMISSION
                        if is_booking
                        else LedgerSourceType.FOOD_ORDER_COMMISSION
                    ),
                    amount=commission,
                    balance_after=platform.balance,
                    booking_id=payable_id if is_booking else None,
                    food_order_id=None if is_booking else payable_id,
                    note=f"5% commission on {payable_type} {payable_id}",
                )
            )

            # ---- 95% -> merchant wallet -------------------------------- #
            if is_booking:
                merchant_type, merchant_model = "tenant", Tenant
                merchant_id = payable.tenant_id
            else:
                merchant_type, merchant_model = "restaurant", Restaurant
                merchant_id = payable.restaurant_id
            merchant = await session.get(
                merchant_model, merchant_id, with_for_update=True
            )
            merchant.wallet_balance += merchant_share

            now = datetime.now(timezone.utc)
            payable.escrow_status = EscrowStatus.RELEASED
            payable.escrow_settled_at = now

            return EscrowSettlement(
                payable_type=payable_type,
                payable_id=str(payable_id),
                total_amount=payable.total_amount,
                commission_amount=commission,
                merchant_amount=merchant_share,
                merchant_type=merchant_type,
                merchant_id=str(merchant_id),
                settled_at=now,
            )
