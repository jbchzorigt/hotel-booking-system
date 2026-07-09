"""
Hotel management CRUD: rooms, minibar catalogue, vicinity restaurants.

Conventions
===========
*   ``tenant_id`` is ALWAYS taken from the authenticated context, never
    from the request body — and RLS's ``WITH CHECK`` would reject a
    mismatch anyway (belt and braces).
*   Deletes are soft (``is_active = False``) wherever history references
    the row (rooms, minibar items); hard deletes are allowed only where
    the FK graph proves nothing depends on it (empty categories).
*   Uniqueness violations (duplicate room number etc.) surface via an
    explicit ``flush()`` inside the endpoint so we can map them to 409 —
    waiting for the dependency-teardown commit would be too late to
    control the response.
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

from app.dependencies.auth import AuthContext, ScopedSession, require_roles
from app.models.domain import (
    MinibarCategory,
    MinibarItem,
    Restaurant,
    Room,
    RoomState,
    RoomType,
    SubscriptionPlan,
    Tenant,
    UserRole,
)

router = APIRouter(prefix="/manager", tags=["management"])

ManagerCtx = Annotated[
    AuthContext,
    Depends(require_roles(UserRole.MANAGER, UserRole.HOTEL_ADMIN)),
]


async def _flush_or_409(session, detail: str) -> None:
    """Surface unique-constraint violations as 409 while we still can."""
    try:
        await session.flush()
    except IntegrityError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail) from exc


# ===========================================================================
# Hotel profile (own tenant)
# ===========================================================================
class HotelProfileOut(BaseModel):
    """The hotel's own record: identity, subscription window, wallet.
    Safe to show its admin/manager — it IS their hotel (RLS-pinned)."""

    id: uuid.UUID
    name: str
    slug: str
    contact_email: str
    contact_phone: str | None
    address: str | None
    maps_lat: float
    maps_lng: float
    subscription_plan: SubscriptionPlan
    subscription_started_at: datetime
    subscription_expires_at: datetime
    is_active: bool
    wallet_balance: Decimal

    model_config = {"from_attributes": True}


@router.get("/hotel", response_model=HotelProfileOut)
async def get_hotel_profile(
    ctx: ManagerCtx, session: ScopedSession
) -> HotelProfileOut:
    """Own-tenant profile for the HOTEL_ADMIN/MANAGER dashboards."""
    tenant = await session.get(Tenant, ctx.tenant_id)
    if tenant is None:  # possible only if the tenant row was hard-deleted
        raise HTTPException(status.HTTP_404_NOT_FOUND, "hotel not found")
    return HotelProfileOut.model_validate(tenant)


# ===========================================================================
# Rooms
# ===========================================================================
class RoomCreate(BaseModel):
    room_number: str = Field(min_length=1, max_length=16)
    room_type: RoomType
    beds: int = Field(ge=1, le=12)
    floor: int = Field(ge=-2, le=200)
    base_price: Decimal = Field(ge=0, decimal_places=2)


class RoomUpdate(BaseModel):
    room_number: str | None = Field(default=None, min_length=1, max_length=16)
    room_type: RoomType | None = None
    beds: int | None = Field(default=None, ge=1, le=12)
    floor: int | None = Field(default=None, ge=-2, le=200)
    base_price: Decimal | None = Field(default=None, ge=0, decimal_places=2)
    is_active: bool | None = None


class RoomOut(BaseModel):
    id: uuid.UUID
    room_number: str
    room_type: RoomType
    beds: int
    floor: int
    state: RoomState
    base_price: Decimal
    is_active: bool

    model_config = {"from_attributes": True}


@router.post("/rooms", response_model=RoomOut, status_code=status.HTTP_201_CREATED)
async def create_room(
    body: RoomCreate, ctx: ManagerCtx, session: ScopedSession
) -> RoomOut:
    room = Room(
        tenant_id=ctx.tenant_id,
        room_number=body.room_number,
        room_type=body.room_type,
        beds=body.beds,
        floor=body.floor,
        base_price=body.base_price,
        state=RoomState.VACANT_CLEAN,
    )
    session.add(room)
    await _flush_or_409(session, f"room number {body.room_number!r} already exists")
    return RoomOut.model_validate(room)


@router.get("/rooms", response_model=list[RoomOut])
async def list_rooms(
    ctx: ManagerCtx,
    session: ScopedSession,
    state: RoomState | None = None,
    include_inactive: bool = False,
) -> list[RoomOut]:
    query = select(Room).order_by(Room.floor, Room.room_number)
    if state is not None:
        query = query.where(Room.state == state)
    if not include_inactive:
        query = query.where(Room.is_active.is_(True))
    rooms = (await session.execute(query)).scalars().all()
    return [RoomOut.model_validate(r) for r in rooms]


@router.patch("/rooms/{room_id}", response_model=RoomOut)
async def update_room(
    room_id: uuid.UUID,
    body: RoomUpdate,
    ctx: ManagerCtx,
    session: ScopedSession,
) -> RoomOut:
    room = await session.get(Room, room_id, with_for_update=True)
    if room is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(room, field, value)
    await _flush_or_409(session, "room number already exists")
    return RoomOut.model_validate(room)


@router.delete("/rooms/{room_id}", status_code=status.HTTP_204_NO_CONTENT)
async def retire_room(
    room_id: uuid.UUID, ctx: ManagerCtx, session: ScopedSession
) -> None:
    """Soft delete — bookings reference rooms forever (FK RESTRICT)."""
    room = await session.get(Room, room_id, with_for_update=True)
    if room is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")
    if room.state == RoomState.OCCUPIED:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "cannot retire an occupied room"
        )
    room.is_active = False


# ===========================================================================
# Minibar categories
# ===========================================================================
class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    sort_order: int = Field(default=0, ge=0, le=1000)


class CategoryOut(BaseModel):
    id: uuid.UUID
    name: str
    sort_order: int

    model_config = {"from_attributes": True}


@router.post(
    "/minibar/categories",
    response_model=CategoryOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_category(
    body: CategoryCreate, ctx: ManagerCtx, session: ScopedSession
) -> CategoryOut:
    category = MinibarCategory(
        tenant_id=ctx.tenant_id, name=body.name, sort_order=body.sort_order
    )
    session.add(category)
    await _flush_or_409(session, f"category {body.name!r} already exists")
    return CategoryOut.model_validate(category)


@router.get("/minibar/categories", response_model=list[CategoryOut])
async def list_categories(
    ctx: ManagerCtx, session: ScopedSession
) -> list[CategoryOut]:
    categories = (
        (
            await session.execute(
                select(MinibarCategory).order_by(
                    MinibarCategory.sort_order, MinibarCategory.name
                )
            )
        )
        .scalars()
        .all()
    )
    return [CategoryOut.model_validate(c) for c in categories]


@router.delete(
    "/minibar/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_category(
    category_id: uuid.UUID, ctx: ManagerCtx, session: ScopedSession
) -> None:
    """Hard delete, allowed only when the category is empty (FK RESTRICT
    turns a non-empty delete into a 409)."""
    category = await session.get(MinibarCategory, category_id)
    if category is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "category not found")
    await session.delete(category)
    await _flush_or_409(
        session, "category still has items; move or retire them first"
    )


# ===========================================================================
# Minibar items
# ===========================================================================
class ItemCreate(BaseModel):
    category_id: uuid.UUID
    name: str = Field(min_length=1, max_length=120)
    price: Decimal = Field(ge=0, decimal_places=2)


class ItemUpdate(BaseModel):
    category_id: uuid.UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    price: Decimal | None = Field(default=None, ge=0, decimal_places=2)
    is_active: bool | None = None


class ItemOut(BaseModel):
    id: uuid.UUID
    category_id: uuid.UUID
    name: str
    price: Decimal
    is_active: bool

    model_config = {"from_attributes": True}


@router.post(
    "/minibar/items", response_model=ItemOut, status_code=status.HTTP_201_CREATED
)
async def create_item(
    body: ItemCreate, ctx: ManagerCtx, session: ScopedSession
) -> ItemOut:
    # RLS scopes the lookup: a foreign category id just doesn't resolve.
    category = await session.get(MinibarCategory, body.category_id)
    if category is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "category not found")
    item = MinibarItem(
        tenant_id=ctx.tenant_id,
        category_id=category.id,
        name=body.name,
        price=body.price,
    )
    session.add(item)
    await _flush_or_409(session, f"item {body.name!r} already exists")
    return ItemOut.model_validate(item)


@router.get("/minibar/items", response_model=list[ItemOut])
async def list_items(
    ctx: ManagerCtx,
    session: ScopedSession,
    include_inactive: bool = False,
) -> list[ItemOut]:
    query = select(MinibarItem).order_by(MinibarItem.name)
    if not include_inactive:
        query = query.where(MinibarItem.is_active.is_(True))
    items = (await session.execute(query)).scalars().all()
    return [ItemOut.model_validate(i) for i in items]


@router.patch("/minibar/items/{item_id}", response_model=ItemOut)
async def update_item(
    item_id: uuid.UUID,
    body: ItemUpdate,
    ctx: ManagerCtx,
    session: ScopedSession,
) -> ItemOut:
    item = await session.get(MinibarItem, item_id, with_for_update=True)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item not found")
    updates = body.model_dump(exclude_unset=True)
    if "category_id" in updates:
        if await session.get(MinibarCategory, updates["category_id"]) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "category not found")
    for field, value in updates.items():
        setattr(item, field, value)
    await _flush_or_409(session, "item name already exists")
    return ItemOut.model_validate(item)


@router.delete("/minibar/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def retire_item(
    item_id: uuid.UUID, ctx: ManagerCtx, session: ScopedSession
) -> None:
    """Soft delete — consumption history snapshots reference the item."""
    item = await session.get(MinibarItem, item_id, with_for_update=True)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item not found")
    item.is_active = False


# ===========================================================================
# Vicinity restaurants
# ===========================================================================
class RestaurantRegister(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    phone: str | None = Field(default=None, max_length=32)


class RestaurantOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    phone: str | None
    is_active: bool

    model_config = {"from_attributes": True}


@router.post(
    "/restaurants",
    response_model=RestaurantOut,
    status_code=status.HTTP_201_CREATED,
)
async def register_restaurant(
    body: RestaurantRegister, ctx: ManagerCtx, session: ScopedSession
) -> RestaurantOut:
    """
    Register a restaurant operating in this hotel's vicinity.

    The hotel only CREATES the listing (RLS: insert allowed for own
    tenant). Menu and order management belong to the RESTAURANT_OWNER
    realm — owner accounts are provisioned by the platform in Phase 4.
    """
    restaurant = Restaurant(
        tenant_id=ctx.tenant_id,
        name=body.name,
        description=body.description,
        phone=body.phone,
    )
    session.add(restaurant)
    await _flush_or_409(
        session, f"restaurant {body.name!r} is already registered here"
    )
    return RestaurantOut.model_validate(restaurant)


@router.get("/restaurants", response_model=list[RestaurantOut])
async def list_restaurants(
    ctx: ManagerCtx, session: ScopedSession
) -> list[RestaurantOut]:
    restaurants = (
        (await session.execute(select(Restaurant).order_by(Restaurant.name)))
        .scalars()
        .all()
    )
    return [RestaurantOut.model_validate(r) for r in restaurants]


class RestaurantUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    phone: str | None = Field(default=None, max_length=32)
    is_active: bool | None = None


@router.patch("/restaurants/{restaurant_id}", response_model=RestaurantOut)
async def update_restaurant(
    restaurant_id: uuid.UUID,
    body: RestaurantUpdate,
    ctx: ManagerCtx,
    session: ScopedSession,
) -> RestaurantOut:
    """Edit the vicinity listing (most commonly the active toggle that
    hides it from guests). RLS: a foreign id simply doesn't resolve."""
    restaurant = await session.get(Restaurant, restaurant_id, with_for_update=True)
    if restaurant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "restaurant not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(restaurant, field, value)
    await _flush_or_409(session, "restaurant name is already registered here")
    return RestaurantOut.model_validate(restaurant)
