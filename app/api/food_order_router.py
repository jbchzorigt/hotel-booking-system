"""
Public food-ordering endpoints: menu browsing and room-delivery orders.

Guest identity = the booking code. A food order must attach to a
CHECKED_IN stay (that's the delivery address AND the payment anchor), and
the restaurant must sit in the SAME hotel's vicinity — the marketplace
sells convenience ("food to my room"), not city-wide delivery.

Money first, kitchen second: the restaurant's WebSocket alert fires only
after the escrow hold succeeded — a kitchen must never start cooking for
a payment that didn't happen.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.websocket_manager import manager, restaurant_topic
from app.core.database import platform_session
from app.dependencies.auth import MarketplaceSession
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
    Tenant,
)
from app.services.payment_escrow_service import (
    EscrowService,
    PaymentDeclinedError,
    PaymentError,
    PaymentInProgressError,
    PaymentMethod,
)

router = APIRouter(prefix="/marketplace", tags=["food-orders"])

_escrow = EscrowService()


# ===========================================================================
# Schemas
# ===========================================================================
class MenuItemPublic(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    category: str | None
    price: Decimal
    image_url: str | None

    model_config = {"from_attributes": True}


class RestaurantMenu(BaseModel):
    restaurant_id: uuid.UUID
    restaurant_name: str
    items: list[MenuItemPublic]


class RestaurantPublic(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    phone: str | None

    model_config = {"from_attributes": True}


class OrderLine(BaseModel):
    food_item_id: uuid.UUID
    quantity: int = Field(ge=1, le=20)


class FoodOrderRequest(BaseModel):
    booking_code: str = Field(min_length=4, max_length=16)
    restaurant_id: uuid.UUID
    items: list[OrderLine] = Field(min_length=1, max_length=30)
    payment_method: PaymentMethod = PaymentMethod.QPAY


class FoodOrderResponse(BaseModel):
    order_id: uuid.UUID
    restaurant_name: str
    room_number: str
    status: FoodOrderStatus
    escrow_status: EscrowStatus
    total_amount: Decimal
    currency: str
    gateway_transaction_id: str


# ===========================================================================
# GET /hotels/{tenant_id}/restaurants — vicinity listings (marketplace realm)
# ===========================================================================
@router.get(
    "/hotels/{tenant_id}/restaurants", response_model=list[RestaurantPublic]
)
async def list_hotel_restaurants(
    tenant_id: uuid.UUID, session: MarketplaceSession
) -> list[RestaurantPublic]:
    """Active restaurants delivering to this hotel's rooms. The
    marketplace realm hides inactive listings by policy."""
    restaurants = (
        (
            await session.execute(
                select(Restaurant)
                .where(Restaurant.tenant_id == tenant_id)
                .order_by(Restaurant.name)
            )
        )
        .scalars()
        .all()
    )
    return [RestaurantPublic.model_validate(r) for r in restaurants]


# ===========================================================================
# GET /restaurants/{id}/menu — public browsing (marketplace realm)
# ===========================================================================
@router.get("/restaurants/{restaurant_id}/menu", response_model=RestaurantMenu)
async def get_menu(
    restaurant_id: uuid.UUID, session: MarketplaceSession
) -> RestaurantMenu:
    """Active restaurant's available items. The marketplace realm makes
    inactive restaurants and unavailable items invisible by policy."""
    restaurant = await session.get(Restaurant, restaurant_id)
    if restaurant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "restaurant not found")
    items = (
        await session.execute(
            select(FoodItem)
            .where(FoodItem.restaurant_id == restaurant_id)
            .order_by(FoodItem.category, FoodItem.name)
        )
    ).scalars().all()
    return RestaurantMenu(
        restaurant_id=restaurant.id,
        restaurant_name=restaurant.name,
        items=[MenuItemPublic.model_validate(i) for i in items],
    )


# ===========================================================================
# POST /order — order food to the guest's room
# ===========================================================================
@router.post(
    "/order", response_model=FoodOrderResponse, status_code=status.HTTP_201_CREATED
)
async def order_food(
    body: FoodOrderRequest,
    idempotency_key: Annotated[
        str, Header(alias="Idempotency-Key", min_length=8, max_length=128)
    ],
) -> FoodOrderResponse:
    """
    Create a food order for an in-house guest and capture payment.

    Sequence: (1) validate stay + vicinity + menu, snapshot prices, create
    the order; (2) idempotent escrow capture; (3) only after the money is
    HELD, alert the restaurant's order screen over its WebSocket topic.
    """
    # ---- txn 1: validate & create --------------------------------------- #
    async with platform_session() as session:
        booking = (
            await session.execute(
                select(Booking).where(Booking.code == body.booking_code)
            )
        ).scalar_one_or_none()
        if booking is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
        if booking.status != BookingStatus.CHECKED_IN:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "room delivery is only available to checked-in guests",
            )

        restaurant = await session.get(Restaurant, body.restaurant_id)
        if restaurant is None or not restaurant.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "restaurant not found")
        if restaurant.tenant_id != booking.tenant_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "this restaurant does not deliver to your hotel",
            )

        room = await session.get(Room, booking.room_id)

        item_ids = [line.food_item_id for line in body.items]
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
        # Per-tenant fee of the delivery hotel (the order's tenant).
        hotel = await session.get(Tenant, booking.tenant_id)

        total = sum(
            (catalogue[l.food_item_id].price * l.quantity for l in body.items),
            Decimal("0.00"),
        )
        order = FoodOrder(
            restaurant_id=restaurant.id,
            tenant_id=booking.tenant_id,
            booking_id=booking.id,
            room_id=booking.room_id,
            status=FoodOrderStatus.PLACED,
            total_amount=total,
            commission_rate=hotel.platform_fee_percent / Decimal("100"),
            commission_amount=Decimal("0.00"),
        )
        session.add(order)
        await session.flush()
        ws_items = []
        for line in body.items:
            item = catalogue[line.food_item_id]
            session.add(
                FoodOrderItem(
                    food_order_id=order.id,
                    food_item_id=item.id,
                    restaurant_id=restaurant.id,
                    item_name=item.name,      # snapshot
                    unit_price=item.price,    # snapshot
                    quantity=line.quantity,
                )
            )
            ws_items.append({"name": item.name, "quantity": line.quantity})
        order_id = order.id
        restaurant_name, room_number = restaurant.name, room.room_number

    # ---- txn 2: idempotent escrow capture -------------------------------- #
    try:
        receipt = await _escrow.pay_food_order(
            order_id, method=body.payment_method, idempotency_key=idempotency_key
        )
    except PaymentDeclinedError:
        # Unpaid PLACED orders are invisible to the restaurant (their feed
        # filters NOT_FUNDED) and get swept by the Phase 5 janitor.
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "payment declined")
    except PaymentInProgressError:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "a payment with this Idempotency-Key is running"
        )
    except PaymentError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))

    # ---- (3) money is HELD — now, and only now, wake the kitchen ---------- #
    await manager.publish(
        restaurant_topic(restaurant.id),
        {
            "type": "NEW_FOOD_ORDER",
            "order_id": str(order_id),
            "room_number": room_number,
            "booking_code": body.booking_code,
            "items": ws_items,
            "total_amount": str(total),
            "status": FoodOrderStatus.PLACED.value,
        },
    )

    return FoodOrderResponse(
        order_id=order_id,
        restaurant_name=restaurant_name,
        room_number=room_number,
        status=FoodOrderStatus.PLACED,
        escrow_status=EscrowStatus.HELD,
        total_amount=Decimal(receipt.amount),
        currency=receipt.currency,
        gateway_transaction_id=receipt.gateway_transaction_id,
    )
