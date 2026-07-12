"""
Restaurant-owner endpoints: menu CRUD, order feed, order fulfilment.

Every endpoint is gated to RESTAURANT_OWNER and rides the owner's
``tenant_session`` (injected by ``get_scoped_session`` with
``restaurant_id`` pinned into the RLS GUCs) — the ``restaurant_isolation``
policies make another restaurant's menu/orders unreachable even if every
filter in this file were deleted.

Fulfilment & money: owners only SEE paid orders (escrow ``HELD``) — an
unpaid PLACED order is a checkout that never completed, not work to cook.
Marking an order DELIVERED triggers the escrow release (5% platform /
95% restaurant wallet) through the platform-realm service, using the same
no-self-deadlock pattern as reception checkout: never await the escrow
call while holding a lock on the same order row in the request session.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.dependencies.auth import AuthContext, ScopedSession, require_roles
from app.models.domain import (
    EscrowStatus,
    FoodItem,
    FoodOrder,
    FoodOrderStatus,
    Restaurant,
    UserRole,
)
from app.services.payment_escrow_service import (
    EscrowService,
    InvalidEscrowStateError,
    PaymentError,
)

router = APIRouter(prefix="/restaurant", tags=["restaurant"])

OwnerCtx = Annotated[AuthContext, Depends(require_roles(UserRole.RESTAURANT_OWNER))]

_escrow = EscrowService()

#: Legal fulfilment transitions. Refund flows (owner cancels a paid order)
#: are a Phase 5 workflow — they need the DISPUTED/REFUNDED escrow legs.
_TRANSITIONS: dict[FoodOrderStatus, frozenset[FoodOrderStatus]] = {
    FoodOrderStatus.PLACED: frozenset({FoodOrderStatus.ACCEPTED}),
    FoodOrderStatus.ACCEPTED: frozenset({FoodOrderStatus.PREPARING}),
    FoodOrderStatus.PREPARING: frozenset({FoodOrderStatus.DELIVERED}),
}


# ===========================================================================
# Schemas
# ===========================================================================
class ProfileUpdate(BaseModel):
    description: str | None = Field(default=None, max_length=2000)
    phone: str | None = Field(default=None, max_length=32)
    is_active: bool | None = None


class ProfileOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    phone: str | None
    is_active: bool

    model_config = {"from_attributes": True}


class MenuItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    category: str | None = Field(default=None, max_length=80)
    price: Decimal = Field(ge=0, decimal_places=2)
    #: Path returned by POST /api/v1/upload, or an absolute image URL.
    image_url: str | None = Field(default=None, max_length=500)


class MenuItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    category: str | None = Field(default=None, max_length=80)
    price: Decimal | None = Field(default=None, ge=0, decimal_places=2)
    is_available: bool | None = None
    image_url: str | None = Field(default=None, max_length=500)


class MenuItemOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    category: str | None
    price: Decimal
    is_available: bool
    image_url: str | None

    model_config = {"from_attributes": True}


class OrderLineOut(BaseModel):
    item_name: str
    unit_price: Decimal
    quantity: int

    model_config = {"from_attributes": True}


class OrderOut(BaseModel):
    id: uuid.UUID
    status: FoodOrderStatus
    escrow_status: EscrowStatus
    total_amount: Decimal
    created_at: datetime
    items: list[OrderLineOut]

    model_config = {"from_attributes": True}


class OrderStatusUpdate(BaseModel):
    status: FoodOrderStatus


# ===========================================================================
# Profile
# ===========================================================================
@router.get("/profile", response_model=ProfileOut)
async def get_profile(ctx: OwnerCtx, session: ScopedSession) -> ProfileOut:
    restaurant = await session.get(Restaurant, ctx.restaurant_id)
    if restaurant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "restaurant not found")
    return ProfileOut.model_validate(restaurant)


@router.patch("/profile", response_model=ProfileOut)
async def update_profile(
    body: ProfileUpdate, ctx: OwnerCtx, session: ScopedSession
) -> ProfileOut:
    restaurant = await session.get(
        Restaurant, ctx.restaurant_id, with_for_update=True
    )
    if restaurant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "restaurant not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(restaurant, field, value)
    return ProfileOut.model_validate(restaurant)


# ===========================================================================
# Menu CRUD
# ===========================================================================
@router.post(
    "/menu-items", response_model=MenuItemOut, status_code=status.HTTP_201_CREATED
)
async def create_menu_item(
    body: MenuItemCreate, ctx: OwnerCtx, session: ScopedSession
) -> MenuItemOut:
    item = FoodItem(
        restaurant_id=ctx.restaurant_id,  # from the token, never the body
        name=body.name,
        description=body.description,
        category=body.category,
        price=body.price,
        image_url=body.image_url,
    )
    session.add(item)
    try:
        await session.flush()
    except IntegrityError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"menu item {body.name!r} already exists"
        ) from exc
    return MenuItemOut.model_validate(item)


@router.get("/menu-items", response_model=list[MenuItemOut])
async def list_menu_items(
    ctx: OwnerCtx,
    session: ScopedSession,
    include_unavailable: bool = True,
) -> list[MenuItemOut]:
    query = select(FoodItem).order_by(FoodItem.category, FoodItem.name)
    if not include_unavailable:
        query = query.where(FoodItem.is_available.is_(True))
    items = (await session.execute(query)).scalars().all()
    return [MenuItemOut.model_validate(i) for i in items]


@router.patch("/menu-items/{item_id}", response_model=MenuItemOut)
async def update_menu_item(
    item_id: uuid.UUID,
    body: MenuItemUpdate,
    ctx: OwnerCtx,
    session: ScopedSession,
) -> MenuItemOut:
    item = await session.get(FoodItem, item_id, with_for_update=True)
    if item is None:  # includes another restaurant's item — RLS hides it
        raise HTTPException(status.HTTP_404_NOT_FOUND, "menu item not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    try:
        await session.flush()
    except IntegrityError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "menu item name already exists"
        ) from exc
    return MenuItemOut.model_validate(item)


@router.delete("/menu-items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def retire_menu_item(
    item_id: uuid.UUID, ctx: OwnerCtx, session: ScopedSession
) -> None:
    """Soft delete — order lines snapshot the item, history must survive."""
    item = await session.get(FoodItem, item_id, with_for_update=True)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "menu item not found")
    item.is_available = False


# ===========================================================================
# Orders
# ===========================================================================
@router.get("/orders", response_model=list[OrderOut])
async def list_orders(
    ctx: OwnerCtx,
    session: ScopedSession,
    order_status: FoodOrderStatus | None = None,
    limit: Annotated[int, Field(ge=1, le=200)] = 50,
) -> list[OrderOut]:
    """Paid orders only, newest first — an unpaid order is not work."""
    query = (
        select(FoodOrder)
        .options(selectinload(FoodOrder.items))
        .where(FoodOrder.escrow_status != EscrowStatus.NOT_FUNDED)
        .order_by(FoodOrder.created_at.desc())
        .limit(limit)
    )
    if order_status is not None:
        query = query.where(FoodOrder.status == order_status)
    orders = (await session.execute(query)).scalars().all()
    return [OrderOut.model_validate(o) for o in orders]


@router.patch("/orders/{order_id}/status", response_model=OrderOut)
async def update_order_status(
    order_id: uuid.UUID,
    body: OrderStatusUpdate,
    ctx: OwnerCtx,
    session: ScopedSession,
) -> OrderOut:
    """
    Advance fulfilment: PLACED -> ACCEPTED -> PREPARING -> DELIVERED.

    DELIVERED settles the money: the escrow service (its own platform-
    realm transaction) releases 95% to the restaurant wallet and 5% to
    the platform, and only then does this request's transaction flip the
    status. Note the plain (unlocked) read before the escrow call — see
    module docstring.
    """
    order = (
        await session.execute(
            select(FoodOrder)
            .options(selectinload(FoodOrder.items))
            .where(FoodOrder.id == order_id)
        )
    ).scalar_one_or_none()
    if order is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "order not found")
    if order.escrow_status == EscrowStatus.NOT_FUNDED:
        raise HTTPException(status.HTTP_409_CONFLICT, "order was never paid")

    allowed = _TRANSITIONS.get(order.status, frozenset())
    if body.status not in allowed:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"cannot go {order.status.value} -> {body.status.value}",
        )

    if body.status == FoodOrderStatus.DELIVERED:
        try:
            await _escrow.release_food_order_escrow(order.id)
        except InvalidEscrowStateError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
        except PaymentError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))

    # Lock only now — the escrow call above is done with the row.
    locked = await session.get(FoodOrder, order.id, with_for_update=True)
    locked.status = body.status
    order.status = body.status  # keep the loaded (items-bearing) view in sync
    if body.status == FoodOrderStatus.DELIVERED:
        order.escrow_status = EscrowStatus.RELEASED
    return OrderOut.model_validate(order)
