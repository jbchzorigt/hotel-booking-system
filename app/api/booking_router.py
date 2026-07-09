"""
Public marketplace endpoints: hotel search (geo) and room booking.

Trust model for guest endpoints
===============================
Guests have no accounts (Phase 1 decision), so these endpoints carry no
JWT. Authorization comes from two places instead:

*   **Reads** (`/search`) run in the ``marketplace`` RLS realm — the
    database itself only yields active hotels/rooms; there is no booking,
    user or wallet data a bug in this router could leak.
*   **Writes** (`/book`) are platform-orchestrated transactions inside
    ``platform_session()``: in the escrow model the platform IS the
    merchant of record for the payment. Every input is validated against
    marketplace-visible state before anything is written.

Search design
=============
Two-stage geo filter: a cheap bounding-box predicate (sargable, index
friendly) selects candidates in SQL, then the exact great-circle
(Haversine) distance is computed and filtered per candidate. Room
availability comes from the ``tenant_available_rooms`` SECURITY DEFINER
function so the public realm never reads booking rows.

Booking correctness
===================
The room row is locked (``FOR UPDATE``) while the booking is inserted,
and the GiST exclusion constraint remains the ultimate arbiter: two
concurrent /book calls for overlapping dates cannot both commit, no
matter what the application layer believes. Payment capture is
idempotent via the client's ``Idempotency-Key`` (Phase 2 guard).
"""

from __future__ import annotations

import math
import secrets
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError

from app.core.database import platform_session
from app.dependencies.auth import MarketplaceSession
from app.models.domain import (
    Booking,
    BookingStatus,
    EscrowStatus,
    PlatformAccount,
    Room,
    RoomState,
    RoomType,
    Tenant,
)
from app.services.payment_escrow_service import (
    EscrowService,
    PaymentDeclinedError,
    PaymentError,
    PaymentInProgressError,
    PaymentMethod,
)

router = APIRouter(prefix="/marketplace", tags=["marketplace"])

_escrow = EscrowService()

_EARTH_RADIUS_KM = 6371.0088
_KM_PER_DEGREE_LAT = 111.32
_MAX_STAY_NIGHTS = 30


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Exact great-circle distance between two WGS-84 points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return _EARTH_RADIUS_KM * 2 * math.asin(math.sqrt(a))


# ===========================================================================
# Schemas
# ===========================================================================
class HotelSearchResult(BaseModel):
    tenant_id: uuid.UUID
    name: str
    slug: str
    address: str | None
    maps_lat: float
    maps_lng: float
    distance_km: float
    #: Cheapest active room (None for hotels with no sellable rooms).
    min_nightly_rate: Decimal | None
    #: Rooms free for the requested dates; total active rooms if no dates.
    available_rooms: int


class PublicRoom(BaseModel):
    """Room as shown on the public hotel page. ``state`` is exposed so the
    UI can flag same-day readiness (the /book endpoint enforces it)."""

    id: uuid.UUID
    room_number: str
    room_type: RoomType
    beds: int
    floor: int
    base_price: Decimal
    state: RoomState

    model_config = {"from_attributes": True}


class HotelDetail(BaseModel):
    tenant_id: uuid.UUID
    name: str
    slug: str
    address: str | None
    maps_lat: float
    maps_lng: float
    rooms: list[PublicRoom]


class BookRequest(BaseModel):
    room_id: uuid.UUID
    guest_full_name: str = Field(min_length=2, max_length=255)
    guest_phone: str = Field(min_length=6, max_length=32)
    guest_email: EmailStr | None = None
    check_in_date: date
    check_out_date: date
    payment_method: PaymentMethod = PaymentMethod.QPAY


class BookResponse(BaseModel):
    booking_id: uuid.UUID
    #: Human-readable reference — the guest's key for check-in and orders.
    booking_code: str
    hotel_name: str
    room_number: str
    check_in_date: date
    check_out_date: date
    nights: int
    nightly_rate: Decimal
    total_amount: Decimal
    currency: str
    status: BookingStatus
    escrow_status: EscrowStatus
    gateway_transaction_id: str


# ===========================================================================
# GET /search — geolocated hotel discovery
# ===========================================================================
@router.get("/search", response_model=list[HotelSearchResult])
async def search_hotels(
    session: MarketplaceSession,
    lat: Annotated[float, Query(ge=-90, le=90)],
    lng: Annotated[float, Query(ge=-180, le=180)],
    radius_km: Annotated[float, Query(gt=0, le=50)] = 5.0,
    check_in: date | None = None,
    check_out: date | None = None,
) -> list[HotelSearchResult]:
    """
    Active hotels within ``radius_km`` of the given point, nearest first.

    With ``check_in``/``check_out``, ``available_rooms`` reflects real
    date-range availability (computed without exposing booking data to
    this public realm).
    """
    if (check_in is None) != (check_out is None):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "provide both check_in and check_out, or neither",
        )
    if check_in is not None and check_out is not None and check_out <= check_in:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "check_out must be after check_in"
        )

    # Stage 1 — sargable bounding box around the search point.
    lat_delta = radius_km / _KM_PER_DEGREE_LAT
    lng_delta = radius_km / (
        _KM_PER_DEGREE_LAT * max(math.cos(math.radians(lat)), 0.01)
    )

    if check_in is not None:
        availability = func.tenant_available_rooms(Tenant.id, check_in, check_out)
    else:
        availability = func.count(Room.id)

    rows = (
        await session.execute(
            select(
                Tenant,
                func.min(Room.base_price).label("min_rate"),
                availability.label("available"),
            )
            .outerjoin(
                Room,
                and_(Room.tenant_id == Tenant.id, Room.is_active.is_(True)),
            )
            .where(
                Tenant.maps_lat.between(lat - lat_delta, lat + lat_delta),
                Tenant.maps_lng.between(lng - lng_delta, lng + lng_delta),
            )
            .group_by(Tenant.id)
        )
    ).all()

    # Stage 2 — exact Haversine filter + sort (candidate set is small).
    results: list[HotelSearchResult] = []
    for tenant, min_rate, available in rows:
        distance = _haversine_km(
            lat, lng, float(tenant.maps_lat), float(tenant.maps_lng)
        )
        if distance > radius_km:
            continue
        results.append(
            HotelSearchResult(
                tenant_id=tenant.id,
                name=tenant.name,
                slug=tenant.slug,
                address=tenant.address,
                maps_lat=float(tenant.maps_lat),
                maps_lng=float(tenant.maps_lng),
                distance_km=round(distance, 3),
                min_nightly_rate=min_rate,
                available_rooms=int(available or 0),
            )
        )
    results.sort(key=lambda h: h.distance_km)
    return results


# ===========================================================================
# GET /hotels/{tenant_id} — public hotel page (details + sellable rooms)
# ===========================================================================
@router.get("/hotels/{tenant_id}", response_model=HotelDetail)
async def hotel_detail(
    tenant_id: uuid.UUID, session: MarketplaceSession
) -> HotelDetail:
    """One hotel with its active rooms. The marketplace realm makes
    inactive hotels/rooms invisible by policy, so a suspended hotel is a
    plain 404 here."""
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "hotel not found")
    rooms = (
        (
            await session.execute(
                select(Room)
                .where(Room.tenant_id == tenant_id, Room.is_active.is_(True))
                .order_by(Room.floor, Room.room_number)
            )
        )
        .scalars()
        .all()
    )
    return HotelDetail(
        tenant_id=tenant.id,
        name=tenant.name,
        slug=tenant.slug,
        address=tenant.address,
        maps_lat=float(tenant.maps_lat),
        maps_lng=float(tenant.maps_lng),
        rooms=[PublicRoom.model_validate(room) for room in rooms],
    )


# ===========================================================================
# POST /book — reserve a room + escrow capture
# ===========================================================================
@router.post("/book", response_model=BookResponse, status_code=status.HTTP_201_CREATED)
async def book_room(
    body: BookRequest,
    idempotency_key: Annotated[
        str, Header(alias="Idempotency-Key", min_length=8, max_length=128)
    ],
) -> BookResponse:
    """
    Book a room and capture payment into escrow (``HELD``).

    Three deliberate transactions:
      1. create the booking (room locked; the GiST exclusion constraint
         makes overlapping live bookings physically impossible);
      2. capture payment via the idempotent escrow service;
      3. flip the booking to CONFIRMED.

    If payment fails after (1), the booking stays PENDING/NOT_FUNDED —
    it holds no funds, blocks the dates only until the expiry janitor
    (Phase 5) cancels it, and the client may retry payment safely with
    the same Idempotency-Key.
    """
    today = date.today()
    if body.check_in_date < today:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "check_in_date is in the past"
        )
    nights = (body.check_out_date - body.check_in_date).days
    if nights < 1:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "check_out must be after check_in"
        )
    if nights > _MAX_STAY_NIGHTS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"stays are limited to {_MAX_STAY_NIGHTS} nights",
        )

    # ---- txn 1: create the PENDING booking ----------------------------- #
    try:
        async with platform_session() as session:
            room = await session.get(Room, body.room_id, with_for_update=True)
            if room is None or not room.is_active:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")
            hotel = await session.get(Tenant, room.tenant_id)
            if hotel is None or not hotel.is_active:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "hotel is not accepting bookings"
                )
            # Same-day arrivals need a room that is sellable RIGHT NOW;
            # future arrivals only need the dates (housekeeping cycles).
            if (
                body.check_in_date == today
                and room.state != RoomState.VACANT_CLEAN
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "room is not ready for same-day check-in",
                )

            platform = (
                await session.execute(select(PlatformAccount).limit(1))
            ).scalar_one_or_none()
            if platform is None:
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    "platform account not initialised",
                )

            total = room.base_price * nights
            booking = Booking(
                tenant_id=hotel.id,
                room_id=room.id,
                code=f"BK-{secrets.token_hex(4).upper()}",
                guest_full_name=body.guest_full_name,
                guest_phone=body.guest_phone,
                guest_email=body.guest_email,
                check_in_date=body.check_in_date,
                check_out_date=body.check_out_date,
                status=BookingStatus.PENDING,
                nightly_rate=room.base_price,
                total_amount=total,
                commission_rate=platform.commission_rate,  # snapshot
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
            booking_id, booking_code = booking.id, booking.code
            hotel_name, room_number = hotel.name, room.room_number
            nightly_rate = room.base_price
    except HTTPException:
        raise

    # ---- txn 2: idempotent escrow capture ------------------------------- #
    try:
        receipt = await _escrow.pay_booking(
            booking_id,
            method=body.payment_method,
            idempotency_key=idempotency_key,
        )
    except PaymentDeclinedError:
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            f"payment declined; booking {booking_code} is reserved as PENDING "
            "— retry payment with the same Idempotency-Key",
        )
    except PaymentInProgressError:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "a payment with this Idempotency-Key is running"
        )
    except PaymentError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))

    # ---- txn 3: confirm ------------------------------------------------- #
    async with platform_session() as session:
        booking = await session.get(Booking, booking_id, with_for_update=True)
        if booking.status == BookingStatus.PENDING:
            booking.status = BookingStatus.CONFIRMED

    return BookResponse(
        booking_id=booking_id,
        booking_code=booking_code,
        hotel_name=hotel_name,
        room_number=room_number,
        check_in_date=body.check_in_date,
        check_out_date=body.check_out_date,
        nights=nights,
        nightly_rate=nightly_rate,
        total_amount=Decimal(receipt.amount),
        currency=receipt.currency,
        status=BookingStatus.CONFIRMED,
        escrow_status=EscrowStatus.HELD,
        gateway_transaction_id=receipt.gateway_transaction_id,
    )
