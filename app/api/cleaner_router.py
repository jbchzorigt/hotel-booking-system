"""
Housekeeping endpoints.

Deliberately PII-free: cleaners see room numbers and catalogue items,
never guest names, contacts or booking financials. The minibar report
references a ROOM; the server resolves the active stay itself, so the
cleaner's client never handles booking identifiers beyond an opaque id.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.websocket_manager import manager, reception_topic
from app.dependencies.auth import AuthContext, ScopedSession, require_roles
from app.models.domain import (
    Booking,
    BookingStatus,
    MinibarConsumption,
    MinibarItem,
    Room,
    RoomState,
    RoomType,
    UserRole,
)

router = APIRouter(prefix="/cleaner", tags=["housekeeping"])

CleanerCtx = Annotated[
    AuthContext,
    Depends(require_roles(UserRole.CLEANER, UserRole.MANAGER, UserRole.HOTEL_ADMIN)),
]


# ===========================================================================
# Schemas
# ===========================================================================
class DirtyRoomOut(BaseModel):
    """Housekeeping view of a room — no guest data, no pricing."""

    id: uuid.UUID
    room_number: str
    floor: int
    room_type: RoomType

    model_config = {"from_attributes": True}


class OccupiedRoomOut(BaseModel):
    """Housekeeping view of an OCCUPIED room — still PII-free: enough to
    file a pre-checkout minibar report, no guest identity or pricing."""

    id: uuid.UUID
    room_number: str
    floor: int
    room_type: RoomType

    model_config = {"from_attributes": True}


class CatalogueItemOut(BaseModel):
    """Minibar catalogue as housekeeping sees it — enough to file a
    report, no stock/cost management fields."""

    id: uuid.UUID
    name: str
    price: Decimal

    model_config = {"from_attributes": True}


class MinibarReportLine(BaseModel):
    minibar_item_id: uuid.UUID
    quantity: int = Field(ge=1, le=99)


class MinibarReportRequest(BaseModel):
    room_id: uuid.UUID
    items: list[MinibarReportLine] = Field(min_length=1, max_length=50)


class RoomMinibarReportRequest(BaseModel):
    """Body for the path-param report — the room comes from the URL."""

    items: list[MinibarReportLine] = Field(min_length=1, max_length=50)


class MinibarReportResponse(BaseModel):
    room_number: str
    lines_recorded: int
    total_amount: Decimal


class MarkCleanResponse(BaseModel):
    room_id: uuid.UUID
    room_number: str
    state: RoomState


# ===========================================================================
# Endpoints
# ===========================================================================
@router.get("/rooms/dirty", response_model=list[DirtyRoomOut])
async def list_dirty_rooms(
    ctx: CleanerCtx,
    session: ScopedSession,
) -> list[DirtyRoomOut]:
    """The cleaner's worklist: VACANT_DIRTY rooms of THEIR hotel only
    (RLS guarantees the scope even if this filter were forgotten)."""
    rooms = (
        (
            await session.execute(
                select(Room)
                .where(
                    Room.state == RoomState.VACANT_DIRTY,
                    Room.is_active.is_(True),
                )
                .order_by(Room.floor, Room.room_number)
            )
        )
        .scalars()
        .all()
    )
    return [DirtyRoomOut.model_validate(room) for room in rooms]


@router.get("/rooms/occupied", response_model=list[OccupiedRoomOut])
async def list_occupied_rooms(
    ctx: CleanerCtx,
    session: ScopedSession,
) -> list[OccupiedRoomOut]:
    """Rooms with a guest currently in them (OCCUPIED). Housekeeping reports
    minibar consumption here — BEFORE checkout, while there is still a
    CHECKED_IN stay to charge. RLS pins the scope to the cleaner's hotel."""
    rooms = (
        (
            await session.execute(
                select(Room)
                .where(
                    Room.state == RoomState.OCCUPIED,
                    Room.is_active.is_(True),
                )
                .order_by(Room.floor, Room.room_number)
            )
        )
        .scalars()
        .all()
    )
    return [OccupiedRoomOut.model_validate(room) for room in rooms]


@router.get("/minibar/items", response_model=list[CatalogueItemOut])
async def list_minibar_catalogue(
    ctx: CleanerCtx,
    session: ScopedSession,
) -> list[CatalogueItemOut]:
    """Active catalogue items for the report form (RLS-scoped to the
    cleaner's hotel)."""
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
    return [CatalogueItemOut.model_validate(item) for item in items]


@router.post("/rooms/{room_id}/mark-clean", response_model=MarkCleanResponse)
async def mark_room_clean(
    room_id: uuid.UUID,
    ctx: CleanerCtx,
    session: ScopedSession,
) -> MarkCleanResponse:
    """Housekeeping state machine: VACANT_DIRTY -> VACANT_CLEAN (the room
    becomes sellable again)."""
    room = await session.get(Room, room_id, with_for_update=True)
    if room is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")
    if room.state != RoomState.VACANT_DIRTY:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"room is {room.state.value}; only VACANT_DIRTY rooms can be "
            "marked clean",
        )
    room.state = RoomState.VACANT_CLEAN
    return MarkCleanResponse(
        room_id=room.id, room_number=room.room_number, state=room.state
    )


async def _report_minibar(
    room_id: uuid.UUID,
    items: list[MinibarReportLine],
    ctx: AuthContext,
    session,
    background_tasks: BackgroundTasks,
) -> MinibarReportResponse:
    """
    Shared report core: record missing minibar items against the room's
    ACTIVE stay and push a real-time notice to the reception screens.

    This is the PRE-CHECKOUT report — it requires a CHECKED_IN booking,
    i.e. it works exactly while the room is still OCCUPIED. The desk sees
    the rows in its checkout preview (``GET /reception/bookings/{id}``)
    and the charge lands on the guest's final invoice. Reports after
    checkout are rejected: the guest who would pay has settled and left.
    """
    room = await session.get(Room, room_id)
    if room is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "room not found")

    booking = (
        await session.execute(
            select(Booking)
            .where(
                Booking.room_id == room.id,
                Booking.status == BookingStatus.CHECKED_IN,
            )
            .order_by(Booking.check_in_date.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if booking is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "no active (checked-in) stay for this room — minibar items can "
            "only be charged to a current guest",
        )

    # Resolve catalogue items; RLS means a foreign hotel's item id simply
    # doesn't resolve, which surfaces as a validation error, not a leak.
    item_ids = [line.minibar_item_id for line in items]
    catalogue = {
        item.id: item
        for item in (
            await session.execute(
                select(MinibarItem).where(MinibarItem.id.in_(item_ids))
            )
        )
        .scalars()
        .all()
    }
    missing = [str(i) for i in item_ids if i not in catalogue]
    if missing:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"unknown minibar item(s): {', '.join(missing)}",
        )

    total = Decimal("0.00")
    for line in items:
        item = catalogue[line.minibar_item_id]
        session.add(
            MinibarConsumption(
                tenant_id=ctx.tenant_id,
                booking_id=booking.id,
                minibar_item_id=item.id,
                reported_by_user_id=ctx.user_id,
                item_name=item.name,          # snapshot
                unit_price=item.price,        # snapshot
                quantity=line.quantity,
            )
        )
        total += item.price * line.quantity

    # Post-commit broadcast: reception must never see a report whose rows
    # could still roll back.
    background_tasks.add_task(
        manager.publish,
        reception_topic(ctx.tenant_id),
        {
            "type": "MINIBAR_REPORT",
            "room_number": room.room_number,
            "booking_code": booking.code,
            "total_amount": str(total),
            "items": [
                {
                    "name": catalogue[line.minibar_item_id].name,
                    "quantity": line.quantity,
                }
                for line in items
            ],
        },
    )

    return MinibarReportResponse(
        room_number=room.room_number,
        lines_recorded=len(items),
        total_amount=total,
    )


@router.post(
    "/rooms/{room_id}/minibar",
    response_model=MinibarReportResponse,
    status_code=status.HTTP_201_CREATED,
)
async def report_room_minibar(
    room_id: uuid.UUID,
    body: RoomMinibarReportRequest,
    ctx: CleanerCtx,
    session: ScopedSession,
    background_tasks: BackgroundTasks,
) -> MinibarReportResponse:
    """Pre-checkout minibar report for an OCCUPIED room (path-param
    variant). See ``_report_minibar`` for the flow contract."""
    return await _report_minibar(
        room_id, body.items, ctx, session, background_tasks
    )


@router.post(
    "/minibar/report",
    response_model=MinibarReportResponse,
    status_code=status.HTTP_201_CREATED,
)
async def report_minibar_consumption(
    body: MinibarReportRequest,
    ctx: CleanerCtx,
    session: ScopedSession,
    background_tasks: BackgroundTasks,
) -> MinibarReportResponse:
    """Legacy body-parameter variant of ``/rooms/{id}/minibar``."""
    return await _report_minibar(
        body.room_id, body.items, ctx, session, background_tasks
    )
