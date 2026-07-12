"""
B2C in-room dining: booking-bound restaurant discovery + QPay-invoiced
food orders for the public marketplace app.

Trust model
===========
The guest's credential here is the opaque ``booking_id`` they received
when creating the booking — the same pattern as the existing
``GET /public/bookings/{id}`` poll endpoint. Every route validates the
booking is an ACTIVE stay (CONFIRMED, i.e. paid, or already CHECKED_IN)
before revealing anything, so a random UUID probe learns nothing and an
expired/cancelled stay cannot order.

Payment lifecycle (mirrors the B2C room-booking flow)
=====================================================
    POST /public/bookings/{id}/orders -> PLACED order, escrow NOT_FUNDED,
                                         + QPay invoice (QR/link)
    guest pays in QPay
    QPay -> POST /payments/qpay-webhook -> ONE atomic NOT_FUNDED -> HELD
          -> restaurant's order screen is alerted over WebSocket
    restaurant fulfils (ACCEPTED/PREPARING/DELIVERED) -> escrow release.

Restaurants only ever see PAID orders (their feed filters NOT_FUNDED), so
an abandoned checkout never reaches a kitchen; the janitor's food-order
sweep cancels stale unpaid PLACED orders after the TTL.

DB boundary: everything runs in ``platform_session`` (platform is the
merchant of record); the anonymous public holds no DB identity. All
validation happens before any row is written.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from app.api.websocket_manager import manager as ws_manager
from app.api.websocket_manager import restaurant_topic
from app.core.config import settings
from app.core.database import platform_session
from app.models.domain import (
    Booking,
    BookingStatus,
    EscrowStatus,
    FoodItem,
    FoodOrder,
    FoodOrderItem,
    FoodOrderStatus,
    PlatformAccount,
    Restaurant,
    Room,
)
from app.services import qpay_service

router = APIRouter(prefix="/public", tags=["b2c-in-room-dining"])

#: Stays that may browse menus and order food to the room.
_ACTIVE_STAY = (BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN)


# ===========================================================================
# Schemas
# ===========================================================================
class PublicMenuItem(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    category: str | None
    price: Decimal
    image_url: str | None

    model_config = {"from_attributes": True}


class PublicRestaurantWithMenu(BaseModel):
    restaurant_id: uuid.UUID
    name: str
    description: str | None
    phone: str | None
    items: list[PublicMenuItem]


class PublicOrderLine(BaseModel):
    menu_item_id: uuid.UUID
    quantity: int = Field(ge=1, le=20)


class PublicFoodOrderRequest(BaseModel):
    restaurant_id: uuid.UUID
    items: list[PublicOrderLine] = Field(min_length=1, max_length=30)


class PublicFoodOrderResponse(BaseModel):
    order_id: uuid.UUID
    restaurant_name: str
    status: FoodOrderStatus          # PLACED — unpaid until the webhook fires
    escrow_status: EscrowStatus      # NOT_FUNDED -> HELD on payment
    total_amount: Decimal
    currency: str
    #: Pay this invoice to fund the order (webhook flips escrow to HELD and
    #: alerts the kitchen).
    qpay_invoice: dict[str, str]


class PublicFoodOrderStatus(BaseModel):
    """Poll target for the guest's payment screen. Metadata only."""

    order_id: uuid.UUID
    status: FoodOrderStatus
    escrow_status: EscrowStatus
    is_funded: bool
    paid_at: datetime | None
    total_amount: Decimal


# ===========================================================================
# Helpers
# ===========================================================================
async def _active_booking_or_404(session, booking_id: uuid.UUID) -> Booking:
    booking = await session.get(Booking, booking_id)
    if booking is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
    if booking.status not in _ACTIVE_STAY:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"booking is {booking.status.value}; in-room dining is available "
            "to CONFIRMED or CHECKED_IN stays only",
        )
    return booking


# ===========================================================================
# GET /public/bookings/{booking_id}/restaurants — nearby menus
# ===========================================================================
@router.get(
    "/bookings/{booking_id}/restaurants",
    response_model=list[PublicRestaurantWithMenu],
)
async def list_booking_restaurants(
    booking_id: uuid.UUID,
) -> list[PublicRestaurantWithMenu]:
    """Active restaurants in the booking's hotel vicinity, each with its
    currently-available menu. The booking's tenant decides the vicinity —
    the guest never supplies (or learns) tenant ids beyond their stay."""
    async with platform_session() as session:
        booking = await _active_booking_or_404(session, booking_id)

        restaurants = (
            (
                await session.execute(
                    select(Restaurant)
                    .where(
                        Restaurant.tenant_id == booking.tenant_id,
                        Restaurant.is_active.is_(True),
                    )
                    .order_by(Restaurant.name)
                )
            )
            .scalars()
            .all()
        )
        if not restaurants:
            return []

        items = (
            (
                await session.execute(
                    select(FoodItem)
                    .where(
                        FoodItem.restaurant_id.in_(
                            [r.id for r in restaurants]
                        ),
                        FoodItem.is_available.is_(True),
                    )
                    .order_by(FoodItem.category, FoodItem.name)
                )
            )
            .scalars()
            .all()
        )
        by_restaurant: dict[uuid.UUID, list[FoodItem]] = {}
        for item in items:
            by_restaurant.setdefault(item.restaurant_id, []).append(item)

        return [
            PublicRestaurantWithMenu(
                restaurant_id=r.id,
                name=r.name,
                description=r.description,
                phone=r.phone,
                items=[
                    PublicMenuItem.model_validate(i)
                    for i in by_restaurant.get(r.id, [])
                ],
            )
            for r in restaurants
        ]


# ===========================================================================
# POST /public/bookings/{booking_id}/orders — PENDING order + QPay invoice
# ===========================================================================
@router.post(
    "/bookings/{booking_id}/orders",
    response_model=PublicFoodOrderResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_food_order(
    booking_id: uuid.UUID, body: PublicFoodOrderRequest
) -> PublicFoodOrderResponse:
    """
    Create an UNPAID (PLACED / escrow NOT_FUNDED) in-room dining order and
    hand back its QPay invoice. The kitchen is alerted only after the
    webhook confirms payment; unpaid orders are janitor-swept after the
    TTL. Prices are snapshotted per line so later menu edits never change
    what the guest owes.
    """
    async with platform_session() as session:
        booking = await _active_booking_or_404(session, booking_id)

        restaurant = await session.get(Restaurant, body.restaurant_id)
        if restaurant is None or not restaurant.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "restaurant not found")
        if restaurant.tenant_id != booking.tenant_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "this restaurant does not deliver to your hotel",
            )

        item_ids = [line.menu_item_id for line in body.items]
        catalogue = {
            item.id: item
            for item in (
                await session.execute(
                    select(FoodItem).where(
                        FoodItem.id.in_(item_ids),
                        FoodItem.restaurant_id == restaurant.id,
                        FoodItem.is_available.is_(True),
                    )
                )
            ).scalars()
        }
        missing = [str(i) for i in item_ids if i not in catalogue]
        if missing:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"unavailable menu item(s): {', '.join(missing)}",
            )

        platform = (
            await session.execute(select(PlatformAccount).limit(1))
        ).scalar_one_or_none()
        if platform is None:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "platform account not initialised",
            )

        total = sum(
            (catalogue[l.menu_item_id].price * l.quantity for l in body.items),
            Decimal("0.00"),
        )
        order = FoodOrder(
            restaurant_id=restaurant.id,
            tenant_id=booking.tenant_id,
            booking_id=booking.id,
            room_id=booking.room_id,
            status=FoodOrderStatus.PLACED,
            total_amount=total,
            commission_rate=platform.commission_rate,  # snapshot
            commission_amount=Decimal("0.00"),
        )
        session.add(order)
        await session.flush()
        for line in body.items:
            item = catalogue[line.menu_item_id]
            session.add(
                FoodOrderItem(
                    food_order_id=order.id,
                    food_item_id=item.id,
                    restaurant_id=restaurant.id,
                    item_name=item.name,      # snapshot
                    unit_price=item.price,    # price_at_time snapshot
                    quantity=line.quantity,
                )
            )

        invoice = await qpay_service.get_qpay_client().create_invoice(
            booking_id=order.id,  # invoice seed — deterministic per order
            amount=total,
            description=f"In-room dining — {restaurant.name}",
        )
        order.qpay_invoice_id = invoice.invoice_id

        return PublicFoodOrderResponse(
            order_id=order.id,
            restaurant_name=restaurant.name,
            status=order.status,
            escrow_status=order.escrow_status,
            total_amount=total,
            currency=settings.PLATFORM_CURRENCY,
            qpay_invoice=invoice.as_dict(),
        )


# ===========================================================================
# GET /public/orders/{order_id} — payment poll
# ===========================================================================
@router.get("/orders/{order_id}", response_model=PublicFoodOrderStatus)
async def get_order_status(order_id: uuid.UUID) -> PublicFoodOrderStatus:
    """Poll target for the guest's payment screen — flips ``is_funded``
    once the QPay webhook lands."""
    async with platform_session() as session:
        order = await session.get(FoodOrder, order_id)
        if order is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "order not found")
        return PublicFoodOrderStatus(
            order_id=order.id,
            status=order.status,
            escrow_status=order.escrow_status,
            is_funded=order.escrow_status != EscrowStatus.NOT_FUNDED,
            paid_at=order.paid_at,
            total_amount=order.total_amount,
        )


# ===========================================================================
# POST /public/orders/{order_id}/simulate-payment — MOCK-ONLY funding
# ===========================================================================
@router.post(
    "/orders/{order_id}/simulate-payment",
    response_model=PublicFoodOrderStatus,
)
async def simulate_order_payment(order_id: uuid.UUID) -> PublicFoodOrderStatus:
    """
    Sandbox helper: fund a food order as if QPay's webhook had fired — the
    SAME atomic conditional UPDATE and the SAME post-commit kitchen alert
    (``NEW_FOOD_ORDER`` on the restaurant's WS topic), so the guest demo
    and the KDS live-update path behave exactly like production.

    Gated on ``QPAY_USE_MOCKS`` — which the config fail-fast guard forbids
    in production — so this endpoint 404s on any real deployment.
    """
    if not settings.QPAY_USE_MOCKS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")

    kitchen_payload: dict | None = None
    kitchen_restaurant_id: uuid.UUID | None = None

    async with platform_session() as session:
        funded = (
            await session.execute(
                update(FoodOrder)
                .where(
                    FoodOrder.id == order_id,
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

        if funded is not None:
            _, kitchen_restaurant_id = funded
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

        order = await session.get(FoodOrder, order_id)
        if order is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "order not found")
        result = PublicFoodOrderStatus(
            order_id=order.id,
            status=order.status,
            escrow_status=order.escrow_status,
            is_funded=order.escrow_status != EscrowStatus.NOT_FUNDED,
            paid_at=order.paid_at,
            total_amount=order.total_amount,
        )

    # Money first, kitchen second — publish only after the commit.
    if kitchen_payload is not None:
        await ws_manager.publish(
            restaurant_topic(kitchen_restaurant_id), kitchen_payload
        )
    return result
