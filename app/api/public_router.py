"""
B2C marketplace: public hotel search, QPay-invoiced bookings, the QPay
payment webhook, and e-Mongolia guest SSO.

Trust & DB boundaries
=====================
*   **Reads** (`GET /public/hotels`) run in the ``marketplace`` RLS realm —
    the DB only yields active hotels/rooms; availability comes from the
    ``tenant_available_rooms`` SECURITY DEFINER projection so booking rows
    are never exposed to the public realm.
*   **Writes** (`POST /public/bookings`, the webhook, guest SSO) are
    platform-orchestrated (``platform_session``): the anonymous public and
    QPay hold no DB identity of their own, and in the escrow model the
    platform is the merchant of record.

Payment lifecycle
=================
    POST /public/bookings  -> PENDING booking + QPay invoice (QR/link)
    guest pays in QPay
    QPay -> POST /payments/qpay-webhook (HMAC-signed)
          -> ONE atomic PENDING->CONFIRMED / NOT_FUNDED->HELD transition.
    checkout (existing reception flow) -> 5/95 escrow release.

The webhook is idempotent by construction: a single
``UPDATE ... WHERE status='PENDING' RETURNING id`` funds the booking
exactly once no matter how many times (or how concurrently) QPay fires it
— the row lock serialises writers and only the first sees status=PENDING.
"""

from __future__ import annotations

import hashlib
import math
import secrets
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, EmailStr, Field, model_validator
from sqlalchemy import and_, func, select, update
from sqlalchemy.exc import IntegrityError

from app.api.websocket_manager import manager as ws_manager
from app.api.websocket_manager import restaurant_topic
from app.core.config import settings
from app.core.database import platform_session
from app.core.passwords import hash_password
from app.core.security import create_access_token
from app.dependencies.auth import MarketplaceSession
from app.models.domain import (
    Booking,
    BookingStatus,
    EscrowStatus,
    FoodOrder,
    FoodOrderItem,
    FoodOrderStatus,
    PlatformAccount,
    Room,
    RoomState,
    Tenant,
    User,
    UserRole,
)
from app.services import gov_service, qpay_service

router = APIRouter(prefix="/public", tags=["b2c-marketplace"])
payments_router = APIRouter(prefix="/payments", tags=["payments"])
guest_auth_router = APIRouter(prefix="/auth", tags=["b2c-marketplace"])

_EARTH_RADIUS_KM = 6371.0088
_KM_PER_DEGREE_LAT = 111.32
_MAX_STAY_NIGHTS = 30


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return _EARTH_RADIUS_KM * 2 * math.asin(math.sqrt(a))


# ===========================================================================
# Schemas — search
# ===========================================================================
class PublicHotel(BaseModel):
    tenant_id: uuid.UUID
    name: str
    slug: str
    address: str | None
    maps_lat: float
    maps_lng: float
    distance_km: float | None
    available_rooms: int
    min_nightly_rate: Decimal | None


# ===========================================================================
# Schemas — booking
# ===========================================================================
class PublicBookingRequest(BaseModel):
    room_id: uuid.UUID
    guest_full_name: str = Field(min_length=2, max_length=255)
    guest_phone: str = Field(min_length=6, max_length=32)
    guest_email: EmailStr | None = None
    check_in_date: date
    check_out_date: date


class PublicBookingResponse(BaseModel):
    booking_id: uuid.UUID
    booking_code: str
    status: BookingStatus
    hotel_name: str
    room_number: str
    nights: int
    total_amount: Decimal
    currency: str
    #: Pay this invoice to fund the booking (webhook flips it to CONFIRMED).
    qpay_invoice: dict[str, str]


class PublicBookingStatus(BaseModel):
    """Poll target for the checkout screen — the guest holds the opaque
    ``booking_id`` from creation, so this needs no auth. Metadata only."""

    booking_id: uuid.UUID
    booking_code: str
    status: BookingStatus
    escrow_status: EscrowStatus
    #: True once QPay has funded the booking (status CONFIRMED / escrow HELD).
    is_funded: bool
    paid_at: datetime | None


# ===========================================================================
# Schemas — webhook
# ===========================================================================
class QPayWebhookResult(BaseModel):
    result: str            # "funded" | "already_funded" | "ignored"
    #: What the invoice funded — "booking" | "food_order" (None if ignored).
    kind: str | None = None
    booking_id: uuid.UUID | None = None
    order_id: uuid.UUID | None = None
    status: BookingStatus | None = None


# ===========================================================================
# Schemas — guest SSO
# ===========================================================================
class EMongoliaLoginRequest(BaseModel):
    """Mock e-Mongolia SSO — provide EITHER an authorization code (routed
    through the gov_service mock) or a phone number."""

    code: str | None = None
    phone: str | None = Field(default=None, max_length=32)

    @model_validator(mode="after")
    def _exactly_one(self) -> "EMongoliaLoginRequest":
        if bool(self.code) == bool(self.phone):
            raise ValueError("provide exactly one of: code, phone")
        return self


class GuestTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    role: UserRole = UserRole.GUEST
    guest_id: uuid.UUID
    full_name: str


# ===========================================================================
# GET /public/hotels — search with date availability
# ===========================================================================
@router.get("/hotels", response_model=list[PublicHotel])
async def search_hotels(
    session: MarketplaceSession,
    check_in: date,
    check_out: date,
    lat: Annotated[float | None, Query(ge=-90, le=90)] = None,
    lng: Annotated[float | None, Query(ge=-180, le=180)] = None,
    radius_km: Annotated[float, Query(gt=0, le=50)] = 10.0,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[PublicHotel]:
    """
    Active hotels with real date-range availability for ``[check_in,
    check_out)``. With ``lat``/``lng`` the result is distance-filtered and
    sorted nearest-first; without, it lists active hotels alphabetically.

    Availability + cheapest rate come from ``tenant_available_rooms`` (the
    RLS-exempt projection), so this public realm never reads booking rows.
    """
    if check_out <= check_in:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "check_out must be after check_in"
        )
    geo = lat is not None and lng is not None
    if (lat is None) != (lng is None):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "provide both lat and lng, or neither",
        )

    query = (
        select(
            Tenant,
            func.min(Room.base_price).label("min_rate"),
            func.tenant_available_rooms(Tenant.id, check_in, check_out).label(
                "available"
            ),
        )
        .outerjoin(
            Room, and_(Room.tenant_id == Tenant.id, Room.is_active.is_(True))
        )
        .group_by(Tenant.id)
    )
    if geo:
        lat_delta = radius_km / _KM_PER_DEGREE_LAT
        lng_delta = radius_km / (
            _KM_PER_DEGREE_LAT * max(math.cos(math.radians(lat)), 0.01)
        )
        query = query.where(
            Tenant.maps_lat.between(lat - lat_delta, lat + lat_delta),
            Tenant.maps_lng.between(lng - lng_delta, lng + lng_delta),
        )
    else:
        query = query.order_by(Tenant.name).limit(limit)

    rows = (await session.execute(query)).all()

    results: list[PublicHotel] = []
    for tenant, min_rate, available in rows:
        distance: float | None = None
        if geo:
            distance = _haversine_km(
                lat, lng, float(tenant.maps_lat), float(tenant.maps_lng)
            )
            if distance > radius_km:
                continue
        results.append(
            PublicHotel(
                tenant_id=tenant.id,
                name=tenant.name,
                slug=tenant.slug,
                address=tenant.address,
                maps_lat=float(tenant.maps_lat),
                maps_lng=float(tenant.maps_lng),
                distance_km=round(distance, 3) if distance is not None else None,
                available_rooms=int(available or 0),
                min_nightly_rate=min_rate,
            )
        )
    if geo:
        results.sort(key=lambda h: h.distance_km or 0.0)
        results = results[:limit]
    return results


# ===========================================================================
# POST /public/bookings — PENDING booking + QPay invoice
# ===========================================================================
@router.post(
    "/bookings",
    response_model=PublicBookingResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_booking(body: PublicBookingRequest) -> PublicBookingResponse:
    """
    Reserve a room as ``PENDING`` and hand back a QPay invoice. The booking
    holds no funds until the webhook confirms payment; the Phase-5 janitor
    sweeps still-unpaid PENDING bookings after their TTL.

    Double-booking is the database's job: the GiST exclusion constraint
    rejects two live bookings whose date ranges overlap on one room — we
    translate that specific violation into a clean 409.
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
    if nights > _MAX_STAY_NIGHTS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"stays are limited to {_MAX_STAY_NIGHTS} nights",
        )

    async with platform_session() as session:
        room = await session.get(Room, body.room_id, with_for_update=True)
        if room is None or not room.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")
        hotel = await session.get(Tenant, room.tenant_id)
        if hotel is None or not hotel.is_active:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "hotel is not accepting bookings"
            )
        if body.check_in_date == today and room.state != RoomState.VACANT_CLEAN:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "room is not ready for same-day check-in"
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
            await session.flush()  # trips the GiST exclusion if overlapping
        except IntegrityError as exc:
            if "excl_bookings_room_date_overlap" in str(exc.orig):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "room is already booked for (part of) these dates",
                ) from exc
            raise

        invoice = await qpay_service.get_qpay_client().create_invoice(
            booking_id=booking.id,
            amount=total,
            description=f"Booking {booking.code} — {hotel.name}",
        )
        booking.qpay_invoice_id = invoice.invoice_id

        return PublicBookingResponse(
            booking_id=booking.id,
            booking_code=booking.code,
            status=booking.status,
            hotel_name=hotel.name,
            room_number=room.room_number,
            nights=nights,
            total_amount=total,
            currency=settings.PLATFORM_CURRENCY,
            qpay_invoice=invoice.as_dict(),
        )


# ===========================================================================
# GET /public/bookings/{id} — payment-status poll (checkout screen)
# ===========================================================================
@router.get("/bookings/{booking_id}", response_model=PublicBookingStatus)
async def get_booking_status(booking_id: uuid.UUID) -> PublicBookingStatus:
    """
    Current status of a booking, for the checkout screen to poll while the
    guest pays. Auth is the opaque ``booking_id`` itself (a capability the
    guest received at creation); runs in ``platform_session`` because the
    public realm cannot read booking rows.
    """
    async with platform_session() as session:
        booking = await session.get(Booking, booking_id)
        if booking is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
        return PublicBookingStatus(
            booking_id=booking.id,
            booking_code=booking.code,
            status=booking.status,
            escrow_status=booking.escrow_status,
            is_funded=booking.escrow_status != EscrowStatus.NOT_FUNDED,
            paid_at=booking.paid_at,
        )


# ===========================================================================
# POST /public/bookings/{id}/simulate-payment — MOCK-ONLY funding trigger
# ===========================================================================
@router.post(
    "/bookings/{booking_id}/simulate-payment",
    response_model=PublicBookingStatus,
)
async def simulate_payment(booking_id: uuid.UUID) -> PublicBookingStatus:
    """
    Sandbox helper: fund a booking as if QPay's webhook had fired, so the
    B2C demo completes without a real bank payment. Runs the SAME atomic,
    idempotent conditional UPDATE the webhook uses.

    Gated on ``QPAY_USE_MOCKS`` — which the config fail-fast guard forbids
    in production — so this endpoint 404s on any real deployment.
    """
    if not settings.QPAY_USE_MOCKS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")

    async with platform_session() as session:
        await session.execute(
            update(Booking)
            .where(
                Booking.id == booking_id,
                Booking.status == BookingStatus.PENDING,
                Booking.escrow_status == EscrowStatus.NOT_FUNDED,
            )
            .values(
                status=BookingStatus.CONFIRMED,
                escrow_status=EscrowStatus.HELD,
                paid_at=datetime.now(timezone.utc),
            )
        )
        booking = await session.get(Booking, booking_id)
        if booking is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
        return PublicBookingStatus(
            booking_id=booking.id,
            booking_code=booking.code,
            status=booking.status,
            escrow_status=booking.escrow_status,
            is_funded=booking.escrow_status != EscrowStatus.NOT_FUNDED,
            paid_at=booking.paid_at,
        )


# ===========================================================================
# POST /payments/qpay-webhook — idempotent funding
# ===========================================================================
@payments_router.post("/qpay-webhook", response_model=QPayWebhookResult)
async def qpay_webhook(request: Request) -> QPayWebhookResult:
    """
    Payment confirmation from QPay. Authenticated by HMAC signature over the
    raw body (`X-QPay-Signature`). Funds the matching booking exactly once
    via a single atomic conditional UPDATE — concurrent/duplicate deliveries
    are absorbed with no double-funding, and always return 200 so QPay stops
    retrying.
    """
    raw = await request.body()
    signature = request.headers.get("X-QPay-Signature", "")
    if not qpay_service.verify_webhook(raw, signature):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid signature")

    try:
        import json

        payload = json.loads(raw or b"{}")
        invoice_id = str(payload["invoice_id"])
        payment_status = str(payload.get("payment_status", "")).upper()
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "malformed payload")

    # Only a successful payment funds a booking. Everything else is a no-op
    # (unpaid PENDING bookings are swept by the janitor after their TTL).
    if payment_status != "PAID":
        return QPayWebhookResult(result="ignored")

    kitchen_payload: dict | None = None
    kitchen_restaurant_id: uuid.UUID | None = None

    async with platform_session() as session:
        # THE idempotency guard: only a row still PENDING/NOT_FUNDED matches,
        # and the row lock serialises concurrent webhook deliveries.
        funded_id = (
            await session.execute(
                update(Booking)
                .where(
                    Booking.qpay_invoice_id == invoice_id,
                    Booking.status == BookingStatus.PENDING,
                    Booking.escrow_status == EscrowStatus.NOT_FUNDED,
                )
                .values(
                    status=BookingStatus.CONFIRMED,
                    escrow_status=EscrowStatus.HELD,
                    paid_at=datetime.now(timezone.utc),
                )
                .returning(Booking.id)
            )
        ).scalar_one_or_none()

        if funded_id is not None:
            return QPayWebhookResult(
                result="funded",
                kind="booking",
                booking_id=funded_id,
                status=BookingStatus.CONFIRMED,
            )

        # Not a booking invoice — try FOOD ORDERS with the same atomic
        # conditional-UPDATE guard (in-room dining, B2C flow). "Paid" for an
        # order means escrow NOT_FUNDED -> HELD; fulfilment status stays
        # PLACED (that is the restaurant's state machine, not QPay's).
        funded_order = (
            await session.execute(
                update(FoodOrder)
                .where(
                    FoodOrder.qpay_invoice_id == invoice_id,
                    FoodOrder.status == FoodOrderStatus.PLACED,
                    FoodOrder.escrow_status == EscrowStatus.NOT_FUNDED,
                )
                .values(
                    escrow_status=EscrowStatus.HELD,
                    paid_at=datetime.now(timezone.utc),
                )
                .returning(FoodOrder.id, FoodOrder.restaurant_id)
            )
        ).one_or_none()

        if funded_order is not None:
            order_id, kitchen_restaurant_id = funded_order
            # Money first, kitchen second: gather the alert payload now so it
            # can be published AFTER this transaction commits.
            lines = (
                await session.execute(
                    select(FoodOrderItem.item_name, FoodOrderItem.quantity)
                    .where(FoodOrderItem.food_order_id == order_id)
                )
            ).all()
            order_row = (
                await session.execute(
                    select(FoodOrder.total_amount, Room.room_number, Booking.code)
                    .join(Room, FoodOrder.room_id == Room.id, isouter=True)
                    .join(Booking, FoodOrder.booking_id == Booking.id, isouter=True)
                    .where(FoodOrder.id == order_id)
                )
            ).one()
            kitchen_payload = {
                "type": "NEW_FOOD_ORDER",
                "order_id": str(order_id),
                "room_number": order_row[1],
                "booking_code": order_row[2],
                "items": [{"name": n, "quantity": q} for n, q in lines],
                "total_amount": str(order_row[0]),
                "status": FoodOrderStatus.PLACED.value,
            }

        if funded_order is None:
            # No row transitioned: already funded (duplicate delivery) or an
            # unknown invoice. Distinguish for a precise, still-200 reply.
            existing_booking = (
                await session.execute(
                    select(Booking.id, Booking.status).where(
                        Booking.qpay_invoice_id == invoice_id
                    )
                )
            ).one_or_none()
            existing_order = (
                await session.execute(
                    select(FoodOrder.id).where(
                        FoodOrder.qpay_invoice_id == invoice_id
                    )
                )
            ).scalar_one_or_none()

    if kitchen_payload is not None:
        # Published only after the funding transaction committed — the
        # kitchen must never start cooking for a payment that didn't happen.
        await ws_manager.publish(
            restaurant_topic(kitchen_restaurant_id), kitchen_payload
        )
        return QPayWebhookResult(
            result="funded",
            kind="food_order",
            order_id=uuid.UUID(kitchen_payload["order_id"]),
        )

    if existing_booking is not None:
        return QPayWebhookResult(
            result="already_funded",
            kind="booking",
            booking_id=existing_booking[0],
            status=existing_booking[1],
        )
    if existing_order is not None:
        return QPayWebhookResult(
            result="already_funded", kind="food_order", order_id=existing_order
        )
    return QPayWebhookResult(result="ignored")


# ===========================================================================
# POST /auth/emongolia — guest SSO
# ===========================================================================
def _guest_email_for(seed: str) -> str:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12]
    return f"guest+{digest}@emongolia.mn"


@guest_auth_router.post("/emongolia", response_model=GuestTokenResponse)
async def emongolia_login(body: EMongoliaLoginRequest) -> GuestTokenResponse:
    """
    Mock e-Mongolia SSO. Resolves a stable guest identity from a code (via
    the gov_service e-Mongolia mock) or a phone number, finds-or-creates a
    ``GUEST`` user, and returns an app-realm JWT for the B2C marketplace.

    Runs in ``platform_session()`` — like the app login, it precedes any
    identity and legitimately crosses tenant boundaries to touch ``users``.
    """
    # ---- resolve identity ---------------------------------------------- #
    if body.code is not None:
        try:
            sso = gov_service.get_emongolia_oauth()
            profile = await sso.fetch_profile(await sso.exchange_code(body.code))
        except gov_service.OAuthExchangeError as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc))
        full_name = profile.full_name
        email = (profile.email or _guest_email_for(profile.subject)).lower()
        phone: str | None = None
    else:
        phone = "".join(ch for ch in body.phone if ch.isdigit() or ch == "+")
        if len(phone.lstrip("+")) < 6:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid phone number"
            )
        full_name = f"Зочин {phone[-4:]}"
        email = _guest_email_for(phone)

    # ---- find or create the GUEST user --------------------------------- #
    async with platform_session() as session:
        user = (
            await session.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()

        if user is None:
            user = User(
                email=email,
                # SSO users never password-login; store an unusable random.
                hashed_password=hash_password(secrets.token_urlsafe(32)),
                full_name=full_name,
                phone=phone,
                role=UserRole.GUEST,
                tenant_id=None,
                restaurant_id=None,
            )
            session.add(user)
            try:
                await session.flush()
            except IntegrityError:  # concurrent first-login race
                user = (
                    await session.execute(
                        select(User).where(User.email == email)
                    )
                ).scalar_one()
        elif user.role != UserRole.GUEST:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "this identity is registered to a non-guest account",
            )

        if not user.is_active:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "account is disabled")

        user.last_login_at = datetime.now(timezone.utc)
        token = create_access_token(
            subject=str(user.id), role=UserRole.GUEST.value, realm="app"
        )
        guest_id, guest_name = user.id, user.full_name

    return GuestTokenResponse(
        access_token=token,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        guest_id=guest_id,
        full_name=guest_name,
    )
