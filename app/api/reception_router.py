"""
Reception (front desk) endpoints: check-in with state-verified identity,
checkout with escrow settlement.

Transaction/ordering discipline (read before modifying!)
=========================================================
*   The request session (``ScopedSession``) is ONE tenant-scoped
    transaction that commits at dependency teardown — i.e. after the
    endpoint returns, before the response is sent, before BackgroundTasks.

*   **Check-in**: booking/room mutations ride the request transaction;
    police screening is scheduled via ``BackgroundTasks`` so it starts
    strictly AFTER our commit — the police-realm session (separate
    connection) must be able to see the persisted registry hash.

*   **Checkout**: the escrow service opens its OWN platform-realm
    transactions that take ``FOR UPDATE`` locks on the booking row.
    Therefore the endpoint reads the booking WITHOUT locking it first —
    locking it in the request session and then awaiting the escrow call
    would deadlock the worker against itself (request session holds the
    row lock and won't commit until the endpoint returns; the endpoint
    won't return until escrow gets that same lock). Status/room mutations
    happen after the escrow calls complete.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.database import tenant_session
from app.dependencies.auth import AuthContext, ScopedSession, require_roles
from app.models.domain import (
    Booking,
    BookingStatus,
    EscrowStatus,
    MinibarConsumption,
    MinibarItem,
    Room,
    RoomState,
    RoomType,
    Tenant,
    UserRole,
)
from app.services import gov_service
from app.services.payment_escrow_service import (
    EscrowService,
    InvalidEscrowStateError,
    PaymentDeclinedError,
    PaymentError,
    PaymentInProgressError,
    PaymentMethod,
)
from app.services.police_service import PoliceScreeningService, compute_registry_hash

router = APIRouter(prefix="/reception", tags=["reception"])

ReceptionCtx = Annotated[
    AuthContext,
    Depends(require_roles(UserRole.RECEPTION, UserRole.MANAGER, UserRole.HOTEL_ADMIN)),
]

#: Module-level singletons: both are stateless facades over pooled
#: resources (Redis client, session factories), safe to share.
_escrow = EscrowService()
_screening = PoliceScreeningService()


# ===========================================================================
# Schemas
# ===========================================================================
class CheckInRequest(BaseModel):
    booking_id: uuid.UUID
    #: Guest's state registry number (РД). Verified against KHUR; only its
    #: HMAC hash is persisted.
    registry_number: str = Field(min_length=8, max_length=16)


class PathCheckInRequest(BaseModel):
    """Body for the path-param check-in. ``registry_number`` is optional:
    walk-ins were KHUR-verified at creation and carry their hash already."""

    registry_number: str | None = Field(
        default=None, min_length=8, max_length=16
    )


class CheckInResponse(BaseModel):
    booking_id: uuid.UUID
    booking_code: str
    room_number: str
    #: Identity as verified by the state registry (auto-filled).
    verified_full_name: str
    #: None when the identity was verified earlier (walk-in flow) — the
    #: address is displayed at capture time and never persisted.
    verified_address: str | None
    status: BookingStatus


class WalkInRequest(BaseModel):
    room_id: uuid.UUID
    #: Guest's РД — verified against KHUR immediately; only the HMAC hash
    #: and the state-verified name are stored.
    guest_registry_number: str = Field(min_length=8, max_length=16)
    check_in_date: date
    check_out_date: date
    guest_phone: str | None = Field(default=None, max_length=32)


class WalkInResponse(BaseModel):
    booking_id: uuid.UUID
    booking_code: str
    room_number: str
    verified_full_name: str
    verified_address: str
    check_in_date: date
    check_out_date: date
    nights: int
    nightly_rate: Decimal
    total_amount: Decimal
    status: BookingStatus
    #: Walk-ins settle the room at the desk during checkout.
    payment_due_at_checkout: bool


class DeskMinibarLine(BaseModel):
    """A last-minute minibar consumption recorded AT the desk — the guest
    is standing there, housekeeping hasn't seen the room yet."""

    catalog_id: uuid.UUID          # MinibarItem id
    quantity: int = Field(ge=1, le=99)


class CheckoutRequest(BaseModel):
    booking_id: uuid.UUID
    #: How outstanding minibar charges are collected at the desk.
    minibar_payment_method: PaymentMethod = PaymentMethod.QPAY
    #: Last-minute consumptions to record and charge in THIS checkout.
    minibar_items: list[DeskMinibarLine] | None = Field(
        default=None, max_length=50
    )


class PathCheckoutRequest(BaseModel):
    """Body for the path-param checkout: desk payment method (covers
    minibar and, for walk-ins, the room charge) plus optional last-minute
    minibar consumptions."""

    payment_method: PaymentMethod = PaymentMethod.QPAY
    minibar_items: list[DeskMinibarLine] | None = Field(
        default=None, max_length=50
    )


class MinibarLineOut(BaseModel):
    item_name: str
    quantity: int
    unit_price: Decimal
    line_total: Decimal


class CheckoutResponse(BaseModel):
    """Final invoice: room + minibar, plus the settlement split. Superset
    of the original checkout payload — existing clients keep working."""

    booking_id: uuid.UUID
    booking_code: str
    guest_full_name: str
    room_number: str
    status: BookingStatus
    room_state: RoomState
    # -- invoice ---------------------------------------------------------- #
    check_in_date: date
    #: ACTUAL departure date. On early checkout this is truncated to today
    #: so the GiST constraint frees the unused nights for resale.
    check_out_date: date
    #: The departure date originally booked (differs on early checkout).
    booked_check_out_date: date
    early_checkout: bool
    #: Billed nights — always the ORIGINAL span (the escrow was captured
    #: for the full booking; early departure is not a refund event).
    nights: int
    nightly_rate: Decimal
    room_total: Decimal
    minibar_lines: list[MinibarLineOut]
    minibar_total: Decimal
    grand_total: Decimal
    # -- settlement (hotel-facing) ----------------------------------------- #
    total_amount: Decimal            # == room_total (kept for compatibility)
    commission_amount: Decimal
    hotel_amount: Decimal
    minibar_charged: Decimal | None  # None when nothing was consumed
    settled_at: datetime


class DeskRoomOut(BaseModel):
    """Front-desk view of a room: operational state, no pricing edits."""

    id: uuid.UUID
    room_number: str
    floor: int
    room_type: RoomType
    state: RoomState

    model_config = {"from_attributes": True}


class DeskBookingOut(BaseModel):
    """Front-desk view of a booking. Reception legitimately handles guest
    names (they greet the guest); registry data stays hashed server-side."""

    id: uuid.UUID
    code: str
    room_id: uuid.UUID
    room_number: str
    guest_full_name: str
    guest_phone: str
    check_in_date: date
    check_out_date: date
    status: BookingStatus
    #: Room-charge snapshot — lets the checkout form preview the invoice.
    total_amount: Decimal


class DeskCatalogueItemOut(BaseModel):
    """Minibar catalogue as the desk sees it — enough to record a
    last-minute consumption during checkout."""

    id: uuid.UUID
    name: str
    price: Decimal

    model_config = {"from_attributes": True}


class BookingDetailOut(BaseModel):
    """
    Checkout PREVIEW — everything the confirm-checkout dialog needs before
    any money moves: the room charge, and crucially the minibar items
    housekeeping has already reported for this stay (unsettled rows, i.e.
    exactly what the settlement will charge on confirm).
    """

    id: uuid.UUID
    code: str
    room_id: uuid.UUID
    room_number: str
    room_state: RoomState
    guest_full_name: str
    guest_phone: str
    check_in_date: date
    check_out_date: date
    nights: int
    status: BookingStatus
    # -- money preview ------------------------------------------------------ #
    nightly_rate: Decimal
    room_total: Decimal
    #: True for walk-ins: the room charge itself is collected on confirm.
    payment_due_at_checkout: bool
    #: What housekeeping reported and the guest hasn't paid yet.
    housekeeping_reported_minibar_items: list[MinibarLineOut]
    housekeeping_reported_minibar_total: Decimal
    #: room_total + reported minibar (desk additions come on top).
    projected_grand_total: Decimal


class CitizenPreviewOut(BaseModel):
    """KHUR identity preview for the check-in form. Nothing is persisted —
    the authoritative fetch/hash happens inside ``POST /check-in``."""

    registry_number: str
    full_name: str
    address: str


# ===========================================================================
# Endpoints
# ===========================================================================
@router.get("/rooms", response_model=list[DeskRoomOut])
async def list_rooms(
    ctx: ReceptionCtx,
    session: ScopedSession,
    state: RoomState | None = None,
) -> list[DeskRoomOut]:
    """Live room board for the desk (RLS scopes to the token's hotel)."""
    query = (
        select(Room)
        .where(Room.is_active.is_(True))
        .order_by(Room.floor, Room.room_number)
    )
    if state is not None:
        query = query.where(Room.state == state)
    rooms = (await session.execute(query)).scalars().all()
    return [DeskRoomOut.model_validate(room) for room in rooms]


@router.get("/bookings", response_model=list[DeskBookingOut])
async def list_bookings(
    ctx: ReceptionCtx,
    session: ScopedSession,
    status_filter: Annotated[
        BookingStatus | None, Query(alias="status")
    ] = None,
    include_all: bool = False,
) -> list[DeskBookingOut]:
    """Desk worklist — defaults to every non-terminal stay; filter with
    ``?status=CONFIRMED`` for today's arrivals board, or pass
    ``?include_all=true`` for the full booking history (PENDING through
    CHECKED_OUT/CANCELLED). RLS pins everything to the token's hotel."""
    query = (
        select(Booking, Room.room_number)
        .join(Room, Booking.room_id == Room.id)
        .order_by(Booking.check_in_date, Booking.created_at)
    )
    if status_filter is not None:
        query = query.where(Booking.status == status_filter)
    elif not include_all:
        query = query.where(
            Booking.status.in_(
                (BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN)
            )
        )
    rows = (await session.execute(query)).all()
    return [
        DeskBookingOut(
            id=booking.id,
            code=booking.code,
            room_id=booking.room_id,
            room_number=room_number,
            guest_full_name=booking.guest_full_name,
            guest_phone=booking.guest_phone,
            check_in_date=booking.check_in_date,
            check_out_date=booking.check_out_date,
            status=booking.status,
            total_amount=booking.total_amount,
        )
        for booking, room_number in rows
    ]


@router.get("/bookings/{booking_id}", response_model=BookingDetailOut)
async def get_booking_detail(
    booking_id: uuid.UUID,
    ctx: ReceptionCtx,
    session: ScopedSession,
) -> BookingDetailOut:
    """Single-booking detail for the checkout dialog: room charge plus the
    housekeeping-reported (still unsettled) minibar items."""
    row = (
        await session.execute(
            select(Booking, Room)
            .join(Room, Booking.room_id == Room.id)
            .where(Booking.id == booking_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
    booking, room = row

    pending = (
        (
            await session.execute(
                select(MinibarConsumption)
                .where(
                    MinibarConsumption.booking_id == booking.id,
                    MinibarConsumption.is_settled.is_(False),
                )
                .order_by(MinibarConsumption.created_at)
            )
        )
        .scalars()
        .all()
    )
    reported_lines = [
        MinibarLineOut(
            item_name=c.item_name,
            quantity=c.quantity,
            unit_price=c.unit_price,
            line_total=c.unit_price * c.quantity,
        )
        for c in pending
    ]
    reported_total = sum(
        (line.line_total for line in reported_lines), Decimal("0.00")
    )

    return BookingDetailOut(
        id=booking.id,
        code=booking.code,
        room_id=booking.room_id,
        room_number=room.room_number,
        room_state=room.state,
        guest_full_name=booking.guest_full_name,
        guest_phone=booking.guest_phone,
        check_in_date=booking.check_in_date,
        check_out_date=booking.check_out_date,
        nights=(booking.check_out_date - booking.check_in_date).days,
        status=booking.status,
        nightly_rate=booking.nightly_rate,
        room_total=booking.total_amount,
        payment_due_at_checkout=(
            booking.escrow_status == EscrowStatus.NOT_FUNDED
        ),
        housekeeping_reported_minibar_items=reported_lines,
        housekeeping_reported_minibar_total=reported_total,
        projected_grand_total=booking.total_amount + reported_total,
    )


@router.get("/minibar/items", response_model=list[DeskCatalogueItemOut])
async def list_minibar_catalogue(
    ctx: ReceptionCtx,
    session: ScopedSession,
) -> list[DeskCatalogueItemOut]:
    """Active minibar catalogue for the checkout form (RLS-scoped). The
    manager/cleaner catalogue endpoints are gated to THEIR roles, so the
    desk needs its own read."""
    items = (
        (
            await session.execute(
                select(MinibarItem)
                .where(MinibarItem.is_active.is_(True))
                .order_by(MinibarItem.name)
            )
        )
        .scalars()
        .all()
    )
    return [DeskCatalogueItemOut.model_validate(item) for item in items]


@router.get("/identity/{registry_number}", response_model=CitizenPreviewOut)
async def preview_citizen_identity(
    registry_number: str, ctx: ReceptionCtx
) -> CitizenPreviewOut:
    """Verify a registry number against KHUR and return the state-held
    identity so the check-in form can auto-fill. Read-only: no hash is
    computed, nothing is stored, and the number is never logged."""
    try:
        citizen = await gov_service.get_khur_api().fetch_citizen(registry_number)
    except gov_service.InvalidRegistryNumberError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    except gov_service.CitizenNotFoundError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "no citizen record for registry number"
        )
    except gov_service.GovUpstreamError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "state registry unavailable, try again"
        )
    return CitizenPreviewOut(
        registry_number=citizen.registry_number,
        full_name=citizen.full_name,
        address=citizen.address,
    )


async def _fetch_citizen_or_http_error(registry_number: str):
    """KHUR lookup with the gov-service errors mapped to HTTP statuses."""
    try:
        return await gov_service.get_khur_api().fetch_citizen(registry_number)
    except gov_service.InvalidRegistryNumberError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    except gov_service.CitizenNotFoundError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "no citizen record for registry number"
        )
    except gov_service.GovUpstreamError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "state registry unavailable, try again"
        )


_MAX_WALK_IN_NIGHTS = 30


@router.post(
    "/walk-in", response_model=WalkInResponse, status_code=status.HTTP_201_CREATED
)
async def create_walk_in_booking(
    body: WalkInRequest,
    ctx: ReceptionCtx,
    session: ScopedSession,
) -> WalkInResponse:
    """
    Book a room for a guest standing at the desk.

    Identity is KHUR-verified NOW (name auto-filled, only the HMAC hash
    stored), so the later check-in call needs no registry number. Payment
    model: walk-ins settle the room charge at the desk during CHECKOUT —
    the booking is created CONFIRMED / escrow NOT_FUNDED, and the checkout
    flow captures-then-releases so the 5%/95% split stays uniform.

    The room is loaded through the tenant-scoped session, so a foreign
    hotel's room id is simply invisible (404), and the GiST exclusion
    constraint still arbitrates date overlaps.
    """
    today = date.today()
    nights = (body.check_out_date - body.check_in_date).days
    if body.check_in_date < today:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "check_in_date is in the past"
        )
    if nights < 1:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "check_out must be after check_in"
        )
    if nights > _MAX_WALK_IN_NIGHTS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"stays are limited to {_MAX_WALK_IN_NIGHTS} nights",
        )

    room = (
        await session.execute(
            select(Room).where(Room.id == body.room_id).with_for_update()
        )
    ).scalar_one_or_none()
    if room is None or not room.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")
    if body.check_in_date == today and room.state != RoomState.VACANT_CLEAN:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"room {room.room_number} is {room.state.value}; "
            "it must be VACANT_CLEAN for a same-day walk-in",
        )

    citizen = await _fetch_citizen_or_http_error(body.guest_registry_number)

    # Per-tenant fee of the reception's own hotel (RLS lets it read its
    # own tenant row).
    hotel = await session.get(Tenant, ctx.tenant_id)

    booking = Booking(
        tenant_id=ctx.tenant_id,
        room_id=room.id,
        code=f"WI-{secrets.token_hex(4).upper()}",
        guest_full_name=citizen.full_name,          # state-verified
        guest_phone=body.guest_phone or "at-desk",
        guest_registry_hash=compute_registry_hash(citizen.registry_number),
        check_in_date=body.check_in_date,
        check_out_date=body.check_out_date,
        status=BookingStatus.CONFIRMED,             # pay-at-desk on checkout
        nightly_rate=room.base_price,
        total_amount=room.base_price * nights,
        commission_rate=hotel.platform_fee_percent / Decimal("100"),
        commission_amount=Decimal("0.00"),
    )
    session.add(booking)
    try:
        await session.flush()
    except IntegrityError as exc:
        if "excl_bookings_room_date_overlap" in str(exc.orig):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "room is already booked for (part of) these dates",
            ) from exc
        raise

    return WalkInResponse(
        booking_id=booking.id,
        booking_code=booking.code,
        room_number=room.room_number,
        verified_full_name=citizen.full_name,
        verified_address=citizen.address,
        check_in_date=booking.check_in_date,
        check_out_date=booking.check_out_date,
        nights=nights,
        nightly_rate=booking.nightly_rate,
        total_amount=booking.total_amount,
        status=booking.status,
        payment_due_at_checkout=True,
    )


async def _perform_check_in(
    booking_id: uuid.UUID,
    registry_number: str | None,
    session,
    background_tasks: BackgroundTasks,
) -> CheckInResponse:
    """
    Shared check-in core:

    1. (marketplace flow) verify the registry number against KHUR and
       auto-fill the verified name; persist only the HMAC hash. Walk-ins
       skip this — they were verified at booking time and carry the hash.
    2. flip booking -> CHECKED_IN, room -> OCCUPIED;
    3. schedule police screening in the background (post-commit) — the
       response is identical whether or not a match occurs.
    """
    row = (
        await session.execute(
            select(Booking, Room)
            .join(Room, Booking.room_id == Room.id)
            .where(Booking.id == booking_id)
            .with_for_update()
        )
    ).one_or_none()
    if row is None:  # nonexistent OR another hotel's (RLS hides it) — same 404
        raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
    booking, room = row

    if booking.status != BookingStatus.CONFIRMED:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"booking is {booking.status.value}; only CONFIRMED "
            "bookings can check in",
        )
    if room.state != RoomState.VACANT_CLEAN:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"room {room.room_number} is {room.state.value}; "
            "housekeeping must clear it first",
        )

    verified_address: str | None = None
    if registry_number is not None:
        citizen = await _fetch_citizen_or_http_error(registry_number)
        booking.guest_full_name = citizen.full_name   # verified identity
        booking.guest_registry_hash = compute_registry_hash(
            citizen.registry_number
        )
        verified_address = citizen.address
    elif not booking.guest_registry_hash:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "registry_number is required — this booking has no verified "
            "identity on file",
        )

    booking.status = BookingStatus.CHECKED_IN
    room.state = RoomState.OCCUPIED

    # Post-commit: fire-and-forget screening on the police-realm engine.
    background_tasks.add_task(
        _screening.schedule_check_in_screening, booking.id
    )

    return CheckInResponse(
        booking_id=booking.id,
        booking_code=booking.code,
        room_number=room.room_number,
        verified_full_name=booking.guest_full_name,
        verified_address=verified_address,
        status=booking.status,
    )


@router.post("/bookings/{booking_id}/check-in", response_model=CheckInResponse)
async def check_in_by_path(
    booking_id: uuid.UUID,
    body: PathCheckInRequest,
    ctx: ReceptionCtx,
    session: ScopedSession,
    background_tasks: BackgroundTasks,
) -> CheckInResponse:
    """Check a guest in. ``registry_number`` is required for marketplace
    bookings and optional for walk-ins (verified at booking time)."""
    return await _perform_check_in(
        booking_id, body.registry_number, session, background_tasks
    )


@router.post("/check-in", response_model=CheckInResponse)
async def check_in(
    body: CheckInRequest,
    ctx: ReceptionCtx,
    session: ScopedSession,
    background_tasks: BackgroundTasks,
) -> CheckInResponse:
    """Legacy body-parameter variant of ``/bookings/{id}/check-in``."""
    return await _perform_check_in(
        body.booking_id, body.registry_number, session, background_tasks
    )


async def _record_desk_minibar_items(
    booking: Booking,
    desk_items: list[DeskMinibarLine],
    ctx: AuthContext,
    session,
) -> None:
    """
    Persist last-minute desk consumptions in a SEPARATE, immediately
    committed tenant transaction.

    Why not the request session: the minibar settlement runs in its own
    platform-realm transaction and can only charge rows that are already
    COMMITTED — rows pending in the request session would be invisible to
    it and silently escape the bill. Catalogue validation happens first
    (in the RLS-scoped request session), so a bad catalog_id aborts the
    checkout BEFORE any row is written or any money moves.
    """
    item_ids = [line.catalog_id for line in desk_items]
    catalogue = {
        item.id: item
        for item in (
            await session.execute(
                select(MinibarItem).where(
                    MinibarItem.id.in_(item_ids),
                    MinibarItem.is_active.is_(True),
                )
            )
        ).scalars()
    }
    missing = [str(i) for i in item_ids if i not in catalogue]
    if missing:  # unknown OR another hotel's item — RLS makes both invisible
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"unknown minibar item(s): {', '.join(missing)}",
        )

    async with tenant_session(
        user_role=ctx.role, tenant_id=ctx.tenant_id
    ) as txn:
        for line in desk_items:
            item = catalogue[line.catalog_id]
            txn.add(
                MinibarConsumption(
                    tenant_id=ctx.tenant_id,
                    booking_id=booking.id,
                    minibar_item_id=item.id,
                    reported_by_user_id=ctx.user_id,  # the receptionist
                    item_name=item.name,      # snapshot
                    unit_price=item.price,    # snapshot
                    quantity=line.quantity,
                )
            )
    # committed here — the settlement transaction below WILL see the rows


async def _perform_checkout(
    booking_id: uuid.UUID,
    payment_method: PaymentMethod,
    desk_items: list[DeskMinibarLine] | None,
    ctx: AuthContext,
    session,
) -> CheckoutResponse:
    """
    Shared checkout core — returns the final invoice.

    1. record any LAST-MINUTE minibar items the receptionist spotted at
       the desk (separate committed txn — see helper above);
    2. settle ALL outstanding minibar charges — housekeeping reports plus
       the desk additions — in one charge (+ 5/95 split, own txn);
    3. walk-ins only: capture the room charge at the desk (their escrow
       is NOT_FUNDED by design — pay-at-checkout), idempotency-keyed on
       the booking so a retried checkout can never double-charge;
    4. release the room escrow (5% platform / 95% hotel wallet, own txn);
    5. flip booking -> CHECKED_OUT, room -> VACANT_DIRTY — and on EARLY
       checkout truncate ``check_out_date`` to today, so the GiST
       no-overlap constraint immediately frees the unused nights for
       resale. Money is untouched: the escrow was released for the full
       booked amount; early departure is not a refund event (that's the
       dispute/refund workflow's job).
    """
    # Plain read — see module docstring for why we MUST NOT lock here.
    row = (
        await session.execute(
            select(Booking, Room)
            .join(Room, Booking.room_id == Room.id)
            .where(Booking.id == booking_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
    booking, room = row

    if booking.status != BookingStatus.CHECKED_IN:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"booking is {booking.status.value}; only CHECKED_IN bookings "
            "can check out",
        )

    # (1) Desk additions BEFORE the settlement so they join this bill.
    # The settlement is idempotency-keyed per booking: items added after
    # it has run would never be charged, so ordering here is load-bearing.
    if desk_items:
        await _record_desk_minibar_items(booking, desk_items, ctx, session)

    try:
        # (2) Minibar first: if the guest's card declines, we abort the
        # whole checkout BEFORE any room money moves.
        minibar_receipt = await _escrow.settle_minibar_charges(
            booking.id,
            method=payment_method,
            idempotency_key=f"minibar-settle:{booking.id}",
        )
        # (3) Walk-in room charge: capture at the desk, then fall through
        # to the uniform release path.
        if booking.escrow_status == EscrowStatus.NOT_FUNDED:
            await _escrow.pay_booking(
                booking.id,
                method=payment_method,
                idempotency_key=f"walkin-room:{booking.id}",
            )
        # (4) Room escrow: 5% -> platform ledger, 95% -> hotel wallet.
        settlement = await _escrow.release_booking_escrow(booking.id)
    except PaymentDeclinedError:
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED, "desk payment was declined"
        )
    except InvalidEscrowStateError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except PaymentInProgressError:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "checkout already in progress"
        )
    except PaymentError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))

    # (5) Operational state — rides the request transaction.
    booking.status = BookingStatus.CHECKED_OUT
    room.state = RoomState.VACANT_DIRTY

    # Early checkout: shrink the occupied date range so the exclusion
    # constraint releases the remaining nights NOW. Billing keeps the
    # original span (captured above); floor at check_in + 1 night to
    # satisfy the ``dates_ordered`` check constraint on same-day stays.
    booked_check_out = booking.check_out_date
    billed_nights = (booked_check_out - booking.check_in_date).days
    today = date.today()
    if today < booked_check_out:
        booking.check_out_date = max(
            today, booking.check_in_date + timedelta(days=1)
        )
    early_checkout = booking.check_out_date != booked_check_out

    # -- Invoice lines (tenant-scoped read; rows were settled in step 1) --- #
    consumptions = (
        (
            await session.execute(
                select(MinibarConsumption)
                .where(MinibarConsumption.booking_id == booking.id)
                .order_by(MinibarConsumption.created_at)
            )
        )
        .scalars()
        .all()
    )
    minibar_lines = [
        MinibarLineOut(
            item_name=c.item_name,
            quantity=c.quantity,
            unit_price=c.unit_price,
            line_total=c.unit_price * c.quantity,
        )
        for c in consumptions
    ]
    minibar_total = sum(
        (line.line_total for line in minibar_lines), Decimal("0.00")
    )

    return CheckoutResponse(
        booking_id=booking.id,
        booking_code=booking.code,
        guest_full_name=booking.guest_full_name,
        room_number=room.room_number,
        status=booking.status,
        room_state=room.state,
        check_in_date=booking.check_in_date,
        check_out_date=booking.check_out_date,
        booked_check_out_date=booked_check_out,
        early_checkout=early_checkout,
        nights=billed_nights,
        nightly_rate=booking.nightly_rate,
        room_total=settlement.total_amount,
        minibar_lines=minibar_lines,
        minibar_total=minibar_total,
        grand_total=settlement.total_amount + minibar_total,
        total_amount=settlement.total_amount,
        commission_amount=settlement.commission_amount,
        hotel_amount=settlement.merchant_amount,
        minibar_charged=(
            Decimal(minibar_receipt.amount) if minibar_receipt else None
        ),
        settled_at=settlement.settled_at,
    )


@router.post("/bookings/{booking_id}/check-out", response_model=CheckoutResponse)
async def check_out_by_path(
    booking_id: uuid.UUID,
    ctx: ReceptionCtx,
    session: ScopedSession,
    body: PathCheckoutRequest | None = None,
) -> CheckoutResponse:
    """Check a guest out and return the final invoice. The optional body
    selects the desk payment method (defaults to QPAY) and may carry
    last-minute minibar consumptions recorded at the desk."""
    method = body.payment_method if body else PaymentMethod.QPAY
    desk_items = body.minibar_items if body else None
    return await _perform_checkout(booking_id, method, desk_items, ctx, session)


@router.post("/checkout", response_model=CheckoutResponse)
async def checkout(
    body: CheckoutRequest,
    ctx: ReceptionCtx,
    session: ScopedSession,
) -> CheckoutResponse:
    """Legacy body-parameter variant of ``/bookings/{id}/check-out``."""
    return await _perform_checkout(
        body.booking_id,
        body.minibar_payment_method,
        body.minibar_items,
        ctx,
        session,
    )
